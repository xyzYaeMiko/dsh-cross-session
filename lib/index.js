/**
 * dsh-cross-session — Host half (generic).
 *
 * Four model-facing tools that let one session's agent discover, read, and
 * talk to OTHER sessions. This is a capability, not a workflow: it owns no
 * storage and no routing of its own. Everything is composed from services the
 * deployment already provides, and every service beyond the two required ones
 * is looked up at call time so the plugin loads on any base-backed profile:
 *
 *   required (waited for by `inject`):
 *     ctx.tools   register the tools
 *     ctx.agents  live Agent registry (ctx.agents.get / list / resume)
 *
 *   optional (looked up with ctx.get at call time):
 *     ctx.sessionController  list + cold resume with the deployment's own
 *                            agent-preset composition (Web/Desktop profiles)
 *     ctx.sessionQuery       cold-safe session listing/read + title projection
 *     ctx.sessions           live Session store, used only as a last-resort read
 *
 * What makes this a conversation rather than a notification: the delivered
 * message is an ordinary user message whose durable `source` is
 * `{ kind: 'agent-message', form: 'relay', senderSessionId }` — the same
 * attribution the built-in subagent relay uses. Clients that know that source
 * render it as "message from another session"; the target model reads the
 * sender from the text prefix. `session_ask` then waits for the target's turn
 * to settle and returns its final assistant text.
 *
 * Deliberately zero imports from `@deepseek-ai/*`: a directory-installed
 * bundle is linked into a profile, so bare host-package imports would resolve
 * from the checkout that contains it (usually without node_modules) and fail
 * to load. Only Node builtins and the sibling settings module are imported.
 *
 * @module dsh-cross-session
 */
import { randomUUID } from 'node:crypto'

import {
  TOOL_NAMES,
  deniedToolsFor,
  loadSettingsFile,
  saveSettingsFile,
  settingsFilePath
} from './settings.mjs'

export const name = 'cross-session'

/** Only the two services a Host must have for any agent-driven tool to exist. */
export const inject = ['tools', 'agents']

/** Built-in policy. The bundle row may override entries through `apply`'s config object. */
const DEFAULTS = Object.freeze({
  /** Relay hops before a conversation is refused; stops two AIs from ping-ponging forever. */
  maxHops: 6,
  /** Hard cap for one `session_ask` wait, in seconds. */
  maxAskSeconds: 300,
  /** Default `session_ask` wait, in seconds. */
  defaultAskSeconds: 120,
  /** `session_list` page cap. */
  maxListRows: 60,
  /** How many recent sessions `session_list` and name matching scan. */
  listScanLimit: 200,
  /** `session_read` page cap. */
  maxReadMessages: 40,
  /** Truncation budget for one transcript entry, in characters. */
  maxReadChars: 2000,
  /** Truncation budget for a relayed reply, in characters. */
  maxReplyChars: 16000,
  /** How long a delivered relay keeps counting towards `maxHops`. */
  relayTtlMs: 10 * 60 * 1000
})

/** Merge the row config over {@link DEFAULTS}; unknown keys and wrong types are ignored. */
function resolveConfig(raw) {
  const merged = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return merged
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) continue
    if (typeof value !== typeof DEFAULTS[key]) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    merged[key] = value
  }
  return merged
}

// ---------------------------------------------------------------------------
// Settings HTTP surface (the Settings page talks to these two routes).
// ---------------------------------------------------------------------------

/** JSON response helper for the plain Node http objects the Web server hands us. */
function sendJson(res, status, value) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  } catch {
    // The peer may already be gone; nothing useful to do.
  }
}

/** Same-origin guard used when the Host trust fence is unavailable. */
function sameOriginOk(req) {
  try {
    const host = String(req.headers.host ?? '')
    if (host.length === 0) return true
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
    const origin = String(req.headers.origin ?? req.headers.referer ?? '')
    if (origin.length === 0) return true
    const parsed = new URL(origin)
    const hostname = parsed.hostname.toLowerCase()
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1') return false
    return true
  } catch {
    return false
  }
}

/**
 * Build the Host connection trust fence for one Host context. The fence is the
 * real authentication (cookie/token); it returns `false` when the peer is
 * trusted and `true` when a rejection status was written.
 */
function createTrustFence(ctx) {
  return (req, res) => {
    let connection
    try {
      connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      connection = undefined
    }
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false
    try {
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection === undefined) return false
      res.statusCode = typeof rejection === 'number' ? rejection : 403
      try {
        res.end()
      } catch {
        // ignore
      }
      return true
    } catch {
      res.statusCode = 403
      try {
        res.end()
      } catch {
        // ignore
      }
      return true
    }
  }
}

/** Read and parse one small JSON request body. */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim().length === 0 ? {} : JSON.parse(text)
}

/** Abort-aware sleep; rejects with the caller's abort reason. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Inline chain-of-thought wrappers that some providers leave inside visible text. */
const INLINE_REASONING_PATTERNS = [
  /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<analysis>[\s\S]*?<\/analysis>/gi,
  /<thought>[\s\S]*?<\/thought>/gi
]

/**
 * Model-visible answer text of one message.
 *
 * Chain of thought is never part of a transcript view: `reasoning` / `thinking`
 * content blocks are dropped (only `text` blocks are read), and inline
 * `<thinking>…</thinking>`-style wrappers inside a text block are removed too.
 * That keeps both the model-facing tool result and the rendered card answer-only.
 * @param message - one derived (or durable) conversation message.
 * @returns its visible answer text, possibly empty for a tool-call-only step.
 */
function answerTextOf(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  const raw = message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  let text = raw
  for (const pattern of INLINE_REASONING_PATTERNS) text = text.replace(pattern, '')
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Longest prefix of `text` that fits `max` characters, with an explicit marker. */
function truncate(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters)`
}

/** Human-readable form of anything thrown or returned as a failure record. */
function failureText(failure) {
  if (failure === null || failure === undefined) return 'unknown failure'
  if (typeof failure === 'string') return failure
  if (typeof failure !== 'object') return String(failure)
  const code = typeof failure.code === 'string' ? `${failure.code}: ` : ''
  if (typeof failure.message === 'string') return `${code}${failure.message}`
  try {
    return `${code}${JSON.stringify(failure)}`
  } catch {
    return `${code}${String(failure)}`
  }
}

/** `ctx.get()` for a service that may legitimately be absent in this deployment. */
function optionalService(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/** Title from a SessionSummary projection block, tolerant about the wire shape. */
function titleOf(summary) {
  const values = summary?.projections?.values
  const title = values?.title
  if (typeof title === 'string') return title
  if (title !== null && typeof title === 'object' && typeof title.title === 'string') return title.title
  return ''
}

/** Working directory from a SessionSummary row. */
function cwdOf(summary) {
  if (typeof summary?.cwd === 'string') return summary.cwd
  const projected = summary?.projections?.values?.workingDirectory
  return typeof projected === 'string' ? projected : ''
}

/** Install the cross-session tools on one Host context. */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /** target session id → relay depth that the next message delivered there inherits. */
  const relayDepth = new Map()

  /** Current relay depth of one sender; sessions that never received a relay start at 0. */
  function depthOf(sessionId) {
    const entry = relayDepth.get(sessionId)
    if (entry === undefined || Date.now() - entry.at > config.relayTtlMs) return 0
    return entry.depth
  }

  /** Refuse a hop past the budget, then record the depth its target would relay with. */
  function noteOutbound(callerId, targetId) {
    const depth = depthOf(callerId)
    if (depth >= config.maxHops) {
      throw new Error(
        `cross-session hop limit reached (${config.maxHops} relays): this conversation is already ${depth} relays deep. ` +
          'Answer directly instead of relaying again.'
      )
    }
    const now = Date.now()
    for (const [sessionId, entry] of relayDepth) {
      if (now - entry.at > config.relayTtlMs) relayDepth.delete(sessionId)
    }
    relayDepth.set(targetId, { depth: depth + 1, at: now })
  }

  /** Cross-session tools are for top-level sessions; a delegated subagent must not escape its parent chain. */
  function assertTopLevel(agent) {
    const header = agent?.session?.header
    if (header === undefined || header === null) return
    if (header.origin === 'subagent' || header.parentSession !== undefined) {
      throw new Error('cross-session tools are available to top-level sessions only, not to delegated subagents')
    }
  }

  /** Live Agent for an exact session id, when the registry has one. */
  function liveAgent(sessionId) {
    try {
      return ctx.agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  /** Append one live Agent's session as a list row. */
  function rowFromAgent(agent, index) {
    const header = agent?.session?.header ?? {}
    return {
      sessionId: String(agent?.id ?? header.id ?? ''),
      title: '',
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      running: agent?.status === 'running',
      blank: typeof agent?.session?.seq === 'number' ? agent.session.seq === 0 : false,
      live: true,
      origin: typeof header.origin === 'string' ? header.origin : '',
      updatedAt: 0,
      order: index
    }
  }

  /** Session rows from the Web/Desktop session controller (titles, activity time, exact run state). */
  async function listViaController(controller, signal) {
    const value = await controller.list({}, signal)
    const items = Array.isArray(value?.items) ? value.items : []
    return items.map((summary, index) => {
      const sessionId = String(summary?.sessionId ?? '')
      const agent = sessionId.length > 0 ? liveAgent(sessionId) : undefined
      return {
        sessionId,
        title: titleOf(summary),
        cwd: cwdOf(summary),
        running: summary?.running === true || agent?.status === 'running',
        blank: summary?.blank === true || (agent !== undefined && agent.session?.seq === 0),
        live: summary?.agentAvailable === true || agent !== undefined,
        origin: typeof summary?.origin === 'string' ? summary.origin : '',
        updatedAt: typeof summary?.updatedAt === 'number' ? summary.updatedAt : 0,
        order: index
      }
    })
  }

  /** Session rows from the cold-safe query engine: headers, newest first, titles folded in one batch. */
  async function listViaQuery(query, signal) {
    const records = await query.listSessions(signal)
    const scan = records.slice(0, config.listScanLimit)
    const ids = scan.map((record) => String(record?.header?.id ?? ''))
    const titles = new Map()
    if (typeof query.readTitleSnapshots === 'function') {
      try {
        const results = await query.readTitleSnapshots(ids, signal)
        for (const result of Array.isArray(results) ? results : []) {
          if (result?.status !== 'fulfilled') continue
          const title = result.value?.title?.title
          if (typeof title === 'string' && title.length > 0) titles.set(String(result.sessionId), title)
        }
      } catch {
        // Titles are optional metadata; the list still works without them.
      }
    }
    return scan.map((record, index) => {
      const header = record?.header ?? {}
      const sessionId = String(header.id ?? '')
      const agent = liveAgent(sessionId)
      return {
        sessionId,
        title: titles.get(sessionId) ?? '',
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        running: agent?.status === 'running',
        blank: agent !== undefined ? agent.session?.seq === 0 : false,
        live: agent !== undefined,
        origin: typeof header.origin === 'string' ? header.origin : '',
        updatedAt: 0,
        order: index
      }
    })
  }

  /** Session rows from the live registry alone — the last resort on minimal deployments. */
  function listViaAgents() {
    const agents = typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
    return agents.map((agent, index) => rowFromAgent(agent, index))
  }

  /** Pick the richest available Session listing tier. */
  async function listRows(signal) {
    const controller = optionalService(ctx, 'sessionController')
    if (typeof controller?.list === 'function') {
      try {
        return await listViaController(controller, signal)
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    const query = optionalService(ctx, 'sessionQuery')
    if (typeof query?.listSessions === 'function') {
      try {
        return await listViaQuery(query, signal)
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return listViaAgents()
  }

  /**
   * Filtered, ordered Session rows.
   * @returns `{rows, total}` where `total` counts matches before the page cut.
   */
  async function describeSessions({ query = '', limit = 30, includeSubagents = false, signal } = {}) {
    const rows = (await listRows(signal)).filter((row) => includeSubagents || row.origin !== 'subagent')
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    const matching =
      needle.length === 0
        ? rows
        : rows.filter(
            (row) =>
              row.title.toLowerCase().includes(needle) ||
              row.sessionId.toLowerCase().includes(needle) ||
              row.cwd.toLowerCase().includes(needle)
          )
    const knownTime = matching.some((row) => row.updatedAt > 0)
    if (knownTime) matching.sort((left, right) => right.updatedAt - left.updatedAt)
    else matching.sort((left, right) => left.order - right.order)
    const pageSize = Math.min(Math.max(Math.floor(limit), 1), config.maxListRows)
    return { rows: matching.slice(0, pageSize), total: matching.length }
  }

  /** Candidate lines used when a session reference is ambiguous. */
  function candidatesText(rows) {
    return rows
      .slice(0, 8)
      .map((row) => `- ${row.sessionId}${row.title.length > 0 ? ` “${row.title}”` : ''}${row.cwd.length > 0 ? ` · ${row.cwd}` : ''}`)
      .join('\n')
  }

  /**
   * Resolve one model-supplied session reference (exact live id, exact id,
   * exact title, or a unique title/working-directory substring) to a row.
   * @throws with candidates when the reference is missing or ambiguous.
   */
  async function resolveRow(reference, signal) {
    if (typeof reference !== 'string' || reference.trim().length === 0) {
      throw new Error('session must be a non-empty session id or a session title from session_list')
    }
    const needle = reference.trim()
    const exactLive = liveAgent(needle)
    if (exactLive !== undefined) return rowFromAgent(exactLive, -1)
    const { rows } = await describeSessions({ limit: config.listScanLimit, signal })
    const byId = rows.find((row) => row.sessionId === needle)
    if (byId !== undefined) return byId
    const lower = needle.toLowerCase()
    const exactTitles = rows.filter((row) => row.title.length > 0 && row.title.toLowerCase() === lower)
    if (exactTitles.length === 1) return exactTitles[0]
    if (exactTitles.length > 1) {
      throw new Error(`session title “${needle}” is ambiguous; pass one of these ids:\n${candidatesText(exactTitles)}`)
    }
    const partial = rows.filter(
      (row) =>
        (row.title.length > 0 && row.title.toLowerCase().includes(lower)) ||
        (row.cwd.length > 0 && row.cwd.toLowerCase().includes(lower))
    )
    if (partial.length === 1) return partial[0]
    if (partial.length > 1) {
      throw new Error(`“${needle}” matches ${partial.length} sessions; pass one of these ids:\n${candidatesText(partial)}`)
    }
    // Unknown to the listing (for example a session without a directory):
    // accept the raw id and let the resume path produce the exact failure.
    return { sessionId: needle, title: '', cwd: '', running: false, blank: false, live: false, origin: '', updatedAt: 0, order: -1 }
  }

  /** Best-effort Session header of a cold session, used to refuse preset sessions we cannot compose. */
  async function readHeader(sessionId, signal) {
    const query = optionalService(ctx, 'sessionQuery')
    if (typeof query?.readTitleSnapshot === 'function') {
      try {
        const observation = await query.readTitleSnapshot(sessionId, signal)
        if (observation?.session !== undefined) return observation.session
      } catch {
        return undefined
      }
    }
    if (typeof query?.listSessions === 'function') {
      try {
        const records = await query.listSessions(signal)
        const record = records.find((candidate) => String(candidate?.header?.id ?? '') === sessionId)
        if (record?.header !== undefined) return record.header
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /**
   * Live Agent for one session id, cold-resuming through the best available
   * tier: the deployment's session controller first (it re-composes agent
   * presets), the generic agent registry factory second (no preset composition).
   */
  async function ensureAgent(sessionId, signal) {
    const live = liveAgent(sessionId)
    if (live !== undefined) return live
    const controller = optionalService(ctx, 'sessionController')
    if (typeof controller?.resolveAgent === 'function') {
      let resolved
      try {
        resolved = await controller.resolveAgent(sessionId)
      } catch (error) {
        throw new Error(`cannot open session ${sessionId}: ${failureText(error)}`)
      }
      if (resolved !== null && typeof resolved === 'object' && resolved.error !== undefined) {
        throw new Error(`cannot open session ${sessionId}: ${failureText(resolved.error)}`)
      }
      if (resolved?.agent !== undefined) return resolved.agent
    }
    const header = await readHeader(sessionId, signal)
    if (header !== undefined && typeof header.agentPreset === 'string' && header.agentPreset.length > 0) {
      throw new Error(
        `session ${sessionId} runs the agent preset “${header.agentPreset}”, and this deployment exposes no session controller to re-compose it. ` +
          'Open that session once in its client, then retry.'
      )
    }
    if (typeof ctx.agents.resume === 'function') {
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId, signal })
        if (handle?.agent !== undefined) return handle.agent
      } catch (error) {
        throw new Error(`cannot resume session ${sessionId}: ${failureText(error)}`)
      }
    }
    throw new Error(`session ${sessionId} is not live and this deployment cannot resume it; open it in its client first`)
  }

  /** Current user/assistant messages of one session, live-preferred and cold-safe. */
  async function readMessages(sessionId, signal) {
    const live = liveAgent(sessionId)
    if (live !== undefined) {
      try {
        // A live session's derived history also carries system/developer/tool
        // rows; the transcript view is only the conversation between the two roles.
        return live.session
          .deriveMessages()
          .filter((message) => message?.role === 'user' || message?.role === 'assistant')
      } catch {
        // Fall through to the cold-safe reader.
      }
    }
    const query = optionalService(ctx, 'sessionQuery')
    if (typeof query?.readSurface === 'function') {
      const snapshot = await query.readSurface(sessionId)
      const messages = []
      for (const event of Array.isArray(snapshot?.events) ? snapshot.events : []) {
        if (event?.type === 'user/message' && event.data?.role === 'user') messages.push(event.data)
        else if (event?.type === 'assistant/message' && event.data?.message?.role === 'assistant') messages.push(event.data.message)
      }
      return messages
    }
    const sessions = optionalService(ctx, 'sessions')
    const attached = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    if (attached !== undefined) return attached.deriveMessages()
    throw new Error(
      `cannot read session ${sessionId}: it is not live and this deployment exposes no session query surface. Open it in its client first.`
    )
  }

  /** Session title for an id that came from a reference instead of a row, best effort. */
  async function titleFor(sessionId, signal) {
    const query = optionalService(ctx, 'sessionQuery')
    if (typeof query?.readTitle !== 'function') return ''
    try {
      const title = await query.readTitle(sessionId, signal)
      return typeof title?.title === 'string' ? title.title : ''
    } catch {
      return ''
    }
  }

  /**
   * Build the durable relay message: an ordinary user-role message attributed
   * to the calling session's Agent. Clients that know the `agent-message`
   * relay source show "from that session"; the text prefix tells the model the
   * same, because message source is not forwarded to the model.
   * @param caller - exact live sender Agent.
   * @param callerTitle - sender Session title for the provenance prefix, or ''.
   * @param text - human/model-authored message body.
   * @param options - `waits` for request/response asks, `urgent` for a forced
   *   insert that interrupted the target's running turn.
   */
  function relayMessage(caller, callerTitle, text, options = {}) {
    const who = callerTitle.length > 0 ? `session ${caller.id} (“${callerTitle}”)` : `session ${caller.id}`
    let guidance
    if (options.urgent === true) {
      guidance =
        'This urgent message was relayed by another session\'s AI and interrupted your current turn. ' +
        'It is now the context to work from; no reply is being waited on.'
    } else if (options.waits === true) {
      guidance =
        'This message was relayed by another session\'s AI, which is waiting for your reply. ' +
        'Your final answer in this session is relayed back to it.'
    } else {
      guidance = 'This message was relayed by another session\'s AI. No reply is being waited on.'
    }
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `Cross-session message from ${who}:\n\n${text}\n\n— ${guidance}` }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id }
    }
  }

  /** Deliver one relay message into a target Agent's inbox. */
  function deliver(agent, message, mode) {
    if (mode === 'steer') agent.steer(message)
    else agent.followup(message)
    return message.id
  }

  /**
   * Force-insert one relay message into a running target.
   *
   * There is no way to append to an in-flight model request, so "urgent" means:
   * abort the target's current turn (preserving its queued work) and wake it
   * with this message as its next turn — the message reaches the model's
   * context immediately after the aborted activity converges, instead of
   * waiting for a long tool call or turn to finish.
   * @param agent - target Agent; may be running or idle.
   * @param message - relay message to deliver.
   * @param running - whether the caller already observed a running turn to
   *   interrupt (the message wording was chosen from this same observation).
   * @returns whether a running turn was interrupted.
   */
  function forceInsert(agent, message, running) {
    if (!running) {
      // Idle target: nothing to interrupt; the message just starts a turn.
      agent.followup(message)
      return false
    }
    // `keepInbox` preserves the target's own queued input; only the active
    // activity is aborted. The wake below runs after the abort converges.
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    agent.followup(message)
    // `followup` appends to the queue. An urgent message must reach the model
    // before input the target already had pending, so move it to the head of
    // the next-turn queue. Ordering is best-effort: if the message was already
    // claimed (unlikely inside an aborting turn) it simply stays where it is.
    try {
      if (agent.inbox !== undefined && typeof agent.inbox.remove === 'function' && typeof agent.inbox.prepend === 'function') {
        if (agent.inbox.remove(message.id)) agent.inbox.prepend('next-turn', message)
      }
    } catch {
      // The message is delivered either way.
    }
    return true
  }

  /**
   * Poll one target session until the delivered message was claimed, a later
   * assistant text exists, and the Agent is idle again.
   * @returns `{settled, reply}`; `reply` is the last non-empty assistant text.
   */
  async function waitForReply(agent, messageId, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    let reply = ''
    let idleSince = 0
    for (;;) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled')
      let messages = []
      try {
        messages = agent.session.deriveMessages()
      } catch {
        messages = []
      }
      const index = messages.findIndex((message) => message?.id === messageId)
      if (index >= 0) {
        const assistantTexts = messages
          .slice(index + 1)
          .filter((message) => message?.role === 'assistant')
          .map(answerTextOf)
          .filter((text) => text.trim().length > 0)
        if (assistantTexts.length > 0) {
          reply = assistantTexts[assistantTexts.length - 1]
          idleSince = 0
        }
        if (agent.status === 'idle') {
          if (reply.length > 0) return { settled: true, reply }
          // Claimed input, but the turn settled with no text (error, cancel,
          // disposal): stop after a short grace instead of burning the budget.
          if (idleSince === 0) idleSince = Date.now()
          else if (Date.now() - idleSince > 3000) return { settled: true, reply: '' }
        } else {
          idleSince = 0
        }
      }
      if (Date.now() >= deadline) return { settled: false, reply }
      await sleep(Math.min(400, Math.max(100, deadline - Date.now())), signal)
    }
  }

  /** Clamp the requested ask budget to the configured window. */
  function askSeconds(requested) {
    const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : config.defaultAskSeconds
    return Math.min(Math.max(Math.floor(value), 5), config.maxAskSeconds)
  }

  const sessionListTool = {
    name: 'session_list',
    description:
      'List the other DSH sessions available to this agent (the user\'s other conversation tabs), with id, title, working directory, and run state. ' +
      'Call it first when you need to know which sessions exist before using session_ask, session_send, or session_read. ' +
      'The current session appears with self=true; blank sessions have no turns yet.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive filter on title, session id, or working directory.' },
        limit: { type: 'number', description: 'Maximum rows to return (default 30).' },
        include_subagents: { type: 'boolean', description: 'Also list internal subagent child sessions. Usually leave false.' }
      },
      required: []
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                running: { type: 'boolean' },
                blank: { type: 'boolean' },
                live: { type: 'boolean' },
                self: { type: 'boolean' },
                updatedAt: { type: 'string' }
              },
              required: ['sessionId', 'title', 'cwd', 'running', 'blank', 'live', 'self', 'updatedAt']
            }
          },
          total: { type: 'number' }
        },
        required: ['sessions', 'total']
      },
      render: (args, value) => {
        const rows = Array.isArray(value.sessions) ? value.sessions : []
        if (rows.length === 0) return [{ type: 'text', text: 'No sessions matched.' }]
        const lines = rows.map((row, index) => {
          const flags = [row.running ? 'running' : 'idle']
          if (row.live) flags.push('live')
          if (row.blank) flags.push('blank')
          if (row.self) flags.push('this session')
          if (row.updatedAt.length > 0) flags.push(row.updatedAt)
          return `${index + 1}. ${row.sessionId}${row.title.length > 0 ? ` “${row.title}”` : ''}\n   ${row.cwd.length > 0 ? row.cwd : '(no working directory)'} · ${flags.join(' · ')}`
        })
        const more = value.total > rows.length ? `\n(${value.total - rows.length} more; narrow with query or raise limit)` : ''
        return [
          {
            type: 'text',
            text: `Sessions:\n${lines.join('\n')}${more}\n\nTalk to one with session_ask({ session: "<id or title>", message: "..." }).`
          }
        ]
      }
    },
    async execute(args, exec) {
      assertTopLevel(exec.agent)
      const callerId = exec.agent?.id ?? ''
      const limit = Number.isFinite(args.limit) ? Math.floor(args.limit) : 30
      const { rows, total } = await describeSessions({
        query: typeof args.query === 'string' ? args.query : '',
        limit,
        includeSubagents: args.include_subagents === true,
        signal: exec.signal
      })
      return {
        total,
        sessions: rows.map((row) => ({
          sessionId: row.sessionId,
          title: row.title,
          cwd: row.cwd,
          running: row.running,
          blank: row.blank,
          live: row.live,
          self: row.sessionId === callerId,
          updatedAt: row.updatedAt > 0 ? new Date(row.updatedAt).toISOString() : ''
        }))
      }
    }
  }

  const sessionReadTool = {
    name: 'session_read',
    description:
      'Read the most recent user/assistant messages of another DSH session without waking its agent and without sending anything. ' +
      'Chain of thought is never included: only visible answer text is returned (reasoning blocks and inline thinking wrappers are stripped). ' +
      'Use it to catch up on what that session has been doing, or to poll for progress after session_send (which does not wait).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: { type: 'string', description: 'Session id or a title from session_list.' },
        limit: { type: 'number', description: 'How many recent messages to return (default 12). Ignored when final_only is true.' },
        final_only: {
          type: 'boolean',
          description:
            'When true, return only the session\'s last assistant answer (its final output) instead of the recent transcript. ' +
            'Use this to poll for the answer after session_send.'
        }
      },
      required: ['session']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'] },
                from: { type: 'string' },
                text: { type: 'string' }
              },
              required: ['role', 'from', 'text']
            }
          },
          truncated: { type: 'boolean' }
        },
        required: ['sessionId', 'title', 'messages', 'truncated']
      },
      render: (args, value) => {
        const messages = Array.isArray(value.messages) ? value.messages : []
        const finalOnly = args.final_only === true
        if (messages.length === 0) {
          return [
            {
              type: 'text',
              text: finalOnly
                ? `Session ${value.sessionId} has no final assistant output yet.`
                : `Session ${value.sessionId} has no user/assistant messages yet.`
            }
          ]
        }
        const lines = messages.map((message) => {
          const speaker =
            message.role === 'assistant' ? 'assistant' : message.from.length > 0 ? `user (from ${message.from})` : 'user'
          return `[${speaker}] ${message.text}`
        })
        const scope = finalOnly ? 'final output' : `last ${messages.length} messages${value.truncated ? ', older ones omitted' : ''}`
        const head = `Session ${value.sessionId}${value.title.length > 0 ? ` “${value.title}”` : ''} (${scope}):`
        return [{ type: 'text', text: `${head}\n\n${lines.join('\n\n')}` }]
      }
    },
    async execute(args, exec) {
      assertTopLevel(exec.agent)
      const row = await resolveRow(args.session, exec.signal)
      const limit = Math.min(Math.max(Number.isFinite(args.limit) ? Math.floor(args.limit) : 12, 1), config.maxReadMessages)
      let messages
      try {
        messages = await readMessages(row.sessionId, exec.signal)
      } catch (error) {
        throw new Error(failureText(error))
      }
      const finalOnly = args.final_only === true
      // Project the transcript answer-only: user rows always stay (even an
      // image-only prompt), assistant rows only when they carry visible text,
      // so tool-call-only steps do not appear as blank rows.
      const rows = messages
        .filter((message) => message?.role === 'user' || message?.role === 'assistant')
        .map((message) => ({ message, text: answerTextOf(message) }))
        .filter((entry) => entry.message.role === 'user' || entry.text.length > 0)
      const selected = finalOnly ? rows.filter((entry) => entry.message.role === 'assistant').slice(-1) : rows.slice(-limit)
      return {
        sessionId: row.sessionId,
        title: row.title.length > 0 ? row.title : await titleFor(row.sessionId, exec.signal),
        messages: selected.map((entry) => ({
          role: entry.message.role,
          from:
            entry.message.role === 'user' && entry.message.source?.kind === 'agent-message'
              ? String(entry.message.source.senderSessionId ?? '')
              : '',
          text: truncate(entry.text, config.maxReadChars)
        })),
        truncated: !finalOnly && rows.length > selected.length
      }
    }
  }

  const sessionAskTool = {
    name: 'session_ask',
    description:
      'Send a message to another DSH session and wait for that session\'s AI to answer. ' +
      'The message is delivered as a relay-attributed user message (the target sees which session sent it), a turn starts there, and the final answer is returned to you. ' +
      'Use session_list first to find the session. The wait is bounded by timeout_seconds; on timeout the message stays delivered and you can poll with session_read.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: { type: 'string', description: 'Session id, exact title, or a unique title/working-directory substring from session_list.' },
        message: { type: 'string', description: 'The message to deliver. Be self-contained: the target does not see your conversation.' },
        timeout_seconds: { type: 'number', description: 'How long to wait for a final answer (default 120, max 300, min 5).' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            'queue (default) queues a distinct turn in the target session; steer injects at its next step boundary, interrupting its current work.'
        }
      },
      required: ['session', 'message']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          messageId: { type: 'string' },
          delivered: { type: 'boolean' },
          settled: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          reply: { type: 'string' }
        },
        required: ['sessionId', 'title', 'messageId', 'delivered', 'settled', 'timedOut', 'reply']
      },
      render: (args, value) => {
        const target = `${value.sessionId}${value.title.length > 0 ? ` “${value.title}”` : ''}`
        if (!value.settled) {
          return [
            {
              type: 'text',
              text: `Delivered to ${target}, but no final answer within ${askSeconds(args.timeout_seconds)}s (the session may still be working).\nUse session_read({ session: "${value.sessionId}" }) to check later.`
            }
          ]
        }
        if (value.reply.length === 0) {
          return [{ type: 'text', text: `${target} settled the turn without producing text (the turn may have been interrupted or errored).` }]
        }
        return [{ type: 'text', text: `Answer from ${target}:\n\n${truncate(value.reply, config.maxReplyChars)}` }]
      }
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined || caller === null) throw new Error('session_ask requires a calling agent')
      assertTopLevel(caller)
      if (typeof args.message !== 'string' || args.message.trim().length === 0) throw new Error('message must be a non-empty string')
      const row = await resolveRow(args.session, exec.signal)
      if (row.sessionId === caller.id) throw new Error('that is the current session; reply directly instead of relaying to yourself')
      noteOutbound(caller.id, row.sessionId)
      const agent = await ensureAgent(row.sessionId, exec.signal)
      const callerTitle = await titleFor(caller.id, exec.signal)
      const message = relayMessage(caller, callerTitle, args.message, { waits: true })
      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      deliver(agent, message, mode)
      const seconds = askSeconds(args.timeout_seconds)
      const waited = await waitForReply(agent, message.id, seconds * 1000, exec.signal)
      return {
        sessionId: row.sessionId,
        title: row.title.length > 0 ? row.title : await titleFor(row.sessionId, exec.signal),
        messageId: message.id,
        delivered: true,
        settled: waited.settled,
        timedOut: !waited.settled,
        reply: truncate(waited.reply, config.maxReplyChars)
      }
    }
  }

  const sessionSendTool = {
    name: 'session_send',
    description:
      'Deliver a message to another DSH session WITHOUT waiting for an answer (fire-and-forget, steer, or urgent force-insert). ' +
      'The target receives it as a relay-attributed user message and runs a turn; check the outcome later with session_read. ' +
      'Set force_insert when the message is urgent: it interrupts the target\'s running turn and puts the message at the head of its next turn ' +
      'instead of waiting for a long tool call or turn to finish. ' +
      'Use session_ask instead when you actually need the answer now.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: { type: 'string', description: 'Session id, exact title, or a unique title/working-directory substring from session_list.' },
        message: { type: 'string', description: 'The message to deliver. Be self-contained: the target does not see your conversation.' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            'queue (default) queues a distinct turn; steer injects at the target\'s next step boundary while it is running. Ignored when force_insert is true.'
        },
        force_insert: {
          type: 'boolean',
          description:
            'Urgent delivery. When the target is running, abort its current turn (its queued input is preserved) and deliver this message as the ' +
            'next turn immediately, so it enters the model context without waiting for the current step. Stops the target\'s current work — use sparingly. ' +
            'When the target is idle this behaves like mode:"queue".'
        }
      },
      required: ['session', 'message']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          messageId: { type: 'string' },
          delivered: { type: 'boolean' },
          mode: { type: 'string', enum: ['queue', 'steer'] },
          interrupted: { type: 'boolean' }
        },
        required: ['sessionId', 'title', 'messageId', 'delivered', 'mode', 'interrupted']
      },
      render: (args, value) => [
        {
          type: 'text',
          text: value.interrupted
            ? `Urgent message delivered to ${value.sessionId}${value.title.length > 0 ? ` “${value.title}”` : ''}: the target's running turn was interrupted (queued work preserved) and this message is its next turn. Use session_read to check the outcome later.`
            : `Message delivered to ${value.sessionId}${value.title.length > 0 ? ` “${value.title}”` : ''} (${value.mode}). It runs in its own session; use session_read to check the answer later.`
        }
      ]
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined || caller === null) throw new Error('session_send requires a calling agent')
      assertTopLevel(caller)
      if (typeof args.message !== 'string' || args.message.trim().length === 0) throw new Error('message must be a non-empty string')
      const row = await resolveRow(args.session, exec.signal)
      if (row.sessionId === caller.id) throw new Error('that is the current session; reply directly instead of relaying to yourself')
      noteOutbound(caller.id, row.sessionId)
      const agent = await ensureAgent(row.sessionId, exec.signal)
      const callerTitle = await titleFor(caller.id, exec.signal)
      const force = args.force_insert === true
      // The guidance text must match what actually happens: only a message that
      // aborts a running turn claims to have interrupted it.
      const willInterrupt = force && agent.status === 'running'
      const message = relayMessage(caller, callerTitle, args.message, { waits: false, urgent: willInterrupt })
      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      let interrupted = false
      if (force) interrupted = forceInsert(agent, message, willInterrupt)
      else deliver(agent, message, mode)
      return {
        sessionId: row.sessionId,
        title: row.title.length > 0 ? row.title : await titleFor(row.sessionId, exec.signal),
        messageId: message.id,
        delivered: true,
        mode,
        interrupted
      }
    }
  }

  ctx.effect(() => {
    const disposers = [sessionListTool, sessionReadTool, sessionAskTool, sessionSendTool].map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Disposal is best-effort during unload.
        }
      }
    }
  })

  // -------------------------------------------------------------------------
  // Settings: which sessions see which tools, plus the Settings page's routes.
  // The tools above are registered first because `tools.restrict()` validates
  // the names it denies against the live global registry.
  // -------------------------------------------------------------------------

  const settingsPath = settingsFilePath(process.env)
  let settings = loadSettingsFile(settingsPath)
  /** session id → disposer of the restriction currently applied to that Agent. */
  const restrictions = new Map()

  /** Apply (or lift) the current visibility policy for one live Agent. */
  function applyAgentPolicy(agent) {
    if (agent === null || typeof agent !== 'object' || agent.id === undefined) return
    const sessionId = String(agent.id)
    const previous = restrictions.get(sessionId)
    if (previous !== undefined) {
      restrictions.delete(sessionId)
      try {
        Promise.resolve(previous()).catch(() => {})
      } catch {
        // Disposal is best-effort during agent teardown.
      }
    }
    let deny
    try {
      const header = agent.session?.header
      const delegated = header !== undefined && header !== null && (header.origin === 'subagent' || header.parentSession !== undefined)
      // Internal subagents are never interactive conversations; their tool list
      // stays clean even when every real session is open.
      deny = delegated ? [...TOOL_NAMES] : deniedToolsFor(settings, sessionId)
    } catch {
      deny = []
    }
    if (deny.length === 0) return
    try {
      const toolLayer = agent.ctx?.tools
      if (toolLayer === undefined || typeof toolLayer.restrict !== 'function') return
      const dispose = toolLayer.restrict({ deny })
      restrictions.set(sessionId, typeof dispose === 'function' ? dispose : () => {})
    } catch {
      // The Agent may be disposed between creation and this call.
    }
  }

  /** Re-evaluate every live Agent; used at startup and after a settings save. */
  function applyAllPolicies() {
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch {
      agents = []
    }
    for (const agent of agents) applyAgentPolicy(agent)
  }

  ctx.on('agent/created', ({ agent }) => {
    applyAgentPolicy(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === null || typeof agent !== 'object' || agent.id === undefined) return
    const sessionId = String(agent.id)
    const dispose = restrictions.get(sessionId)
    if (dispose === undefined) return
    restrictions.delete(sessionId)
    try {
      Promise.resolve(dispose()).catch(() => {})
    } catch {
      // ignore
    }
  })
  applyAllPolicies()

  /** Persist settings and re-apply visibility to every live Agent. */
  function persistSettings(next) {
    settings = saveSettingsFile(settingsPath, next)
    applyAllPolicies()
    return settings
  }

  // The Settings page (client half) reads and writes settings through these
  // routes. A Host without the browser carrier simply has no Settings page, and
  // `webServer` may only become available after this plugin applies, so the
  // registration waits for the service through `ctx.inject` instead of reading
  // it once.
  const registerSettingsRoutes = (serverCtx) => {
    const server = optionalService(serverCtx, 'webServer')
    if (server === undefined || typeof server.register !== 'function') return
    const rejectUntrusted = createTrustFence(ctx)
    try {
      serverCtx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/api/cross-session/settings',
            handler: async (req, res) => {
              if (rejectUntrusted(req, res)) return
              if (!sameOriginOk(req)) {
                sendJson(res, 403, { ok: false, error: 'same-origin request required' })
                return
              }
              try {
                if (req.method === 'GET') {
                  sendJson(res, 200, { ok: true, value: settings })
                  return
                }
                if (req.method === 'POST' || req.method === 'PUT') {
                  const body = await readJsonBody(req)
                  sendJson(res, 200, { ok: true, value: persistSettings(body) })
                  return
                }
                sendJson(res, 405, { ok: false, error: 'method not allowed' })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
              }
            }
          }),
        'cross-session: settings route'
      )
    } catch {
      // A duplicate registration or a Host that rejects the route is fine: the
      // plugin keeps working, only the Settings page loses its data route.
    }
  }
  registerSettingsRoutes(ctx)
  try {
    ctx.inject(['webServer'], (serverCtx) => {
      registerSettingsRoutes(serverCtx)
    })
  } catch {
    // No conditional-injection support: keep running without the route.
  }
}

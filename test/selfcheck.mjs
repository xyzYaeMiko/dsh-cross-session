#!/usr/bin/env node
/**
 * dsh-cross-session self-check.
 *
 * Runs with plain `node test/selfcheck.mjs` — no DSH installation, no profile
 * changes. It applies the plugin to a fake Host context, exercises every tool
 * and guard, and, when the real `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-session`
 * packages are discoverable on this machine, cross-checks the tool schemas and
 * the relay message against the actual validators. Those external cross-checks
 * are skipped (never failed) when the packages are absent.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply } from '../lib/index.js'
import { deniedToolsFor, loadSettingsFile, normalizeSettings, saveSettingsFile, settingsFilePath } from '../lib/settings.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Optional real-package discovery (best effort; absence is not a failure).
// ---------------------------------------------------------------------------

/** Directory roots that may contain `@deepseek-ai/<package>` directories. */
function candidateRoots() {
  const roots = []
  const push = (root) => {
    if (typeof root === 'string' && root.length > 0 && !roots.includes(root)) roots.push(root)
  }
  push(process.env.DSH_HOST_MODULES)
  push(process.env.DSH_PACKAGE_ROOT)
  const home = homedir()
  push(join(home, '.local', 'lib', 'node_modules', '@deepseek-ai'))
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')
  if (process.env.DSH_PROFILE_DIR) push(join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai'))
  try {
    const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch {
    // no profiles here
  }
  return roots
}

/** Resolve a package's `exports["."]` entry file inside one `@deepseek-ai` root directory. */
function entryFileIn(root, packageName) {
  try {
    const packageDir = join(root, packageName.replace('@deepseek-ai/', ''))
    const manifestFile = join(packageDir, 'package.json')
    if (!existsSync(manifestFile)) return undefined
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const dot = manifest.exports?.['.']
    const rel = typeof dot === 'string' ? dot : dot?.import ?? dot?.default ?? manifest.module ?? manifest.main
    if (typeof rel !== 'string') return undefined
    const file = join(packageDir, rel.replace(/^\.\//, ''))
    return existsSync(file) ? file : undefined
  } catch {
    return undefined
  }
}

/** pnpm's link store keeps a full dependency closure next to each package. */
function pnpmLinkEntry(packageName) {
  const [scope, name] = packageName.split('/')
  const base = join(homedir(), '.local', 'share', 'pnpm', 'store', 'v11', 'links', scope, name)
  if (!existsSync(base)) return undefined
  try {
    for (const version of readdirSync(base)) {
      for (const hash of readdirSync(join(base, version))) {
        const file = join(base, version, hash, 'node_modules', scope, name, 'lib', 'index.js')
        if (existsSync(file)) return file
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Import one real host package, or return undefined. */
async function loadHostPackage(packageName) {
  try {
    return await import(packageName)
  } catch {
    // Not resolvable from this checkout; fall through to discovery.
  }
  const file = pnpmLinkEntry(packageName) ?? candidateRoots().map((root) => entryFileIn(root, packageName)).find(Boolean)
  if (file === undefined) return undefined
  try {
    return await import(pathToFileURL(file).href)
  } catch {
    return undefined
  }
}

const realTools = await loadHostPackage('@deepseek-ai/dsh-tools')
const realSession = await loadHostPackage('@deepseek-ai/dsh-session')
const external = {
  tools: realTools !== undefined,
  session: realSession !== undefined
}

// ---------------------------------------------------------------------------
// Fake Host harness.
// ---------------------------------------------------------------------------

/** A fake live Agent whose inbox "runs" a turn and appends an assistant reply. */
function makeFakeAgent(id, options = {}) {
  const { title = '', cwd = `/work/${id}`, reply = 'acknowledged', delayMs = 15, autoReply = true, header = {} } = options
  const agent = {
    id,
    title,
    status: 'idle',
    messages: [],
    pending: [],
    runs: 0,
    timer: null,
    cancelled: null,
    /** Tool-visibility restrictions applied to this Agent by the policy layer. */
    restrictCalls: [],
    restrictDisposed: 0,
    ctx: {
      tools: {
        restrict(filter) {
          agent.restrictCalls.push(filter)
          return () => {
            agent.restrictDisposed += 1
          }
        }
      }
    },
    inbox: {
      removed: [],
      prepended: [],
      remove(messageId) {
        agent.inbox.removed.push(messageId)
        return true
      },
      prepend(target, message) {
        agent.inbox.prepended.push({ target, message })
      }
    },
    session: {
      header: { version: 1, id, createdAt: Date.now(), cwd, isSeeded: false, ...header },
      seq: 0,
      deriveMessages: () => agent.messages
    },
    followup(message) {
      enqueue(message)
    },
    steer(message) {
      enqueue(message)
    },
    cancel(cause, options = {}) {
      agent.cancelled = { cause, options }
      // Simulate the abort converging: the active fake activity stops and the
      // agent returns to idle, so a following wake can open its next turn.
      if (agent.timer !== null) {
        clearTimeout(agent.timer)
        agent.timer = null
      }
      agent.status = 'idle'
    }
  }

  function enqueue(message) {
    agent.pending.push(message)
    if (agent.timer === null) {
      agent.timer = setTimeout(claim, 5)
      agent.timer.unref?.()
    }
  }

  function claim() {
    agent.timer = null
    const message = agent.pending.shift()
    if (message === undefined) return
    agent.status = 'running'
    agent.messages.push(message)
    agent.session.seq += 1
    if (!autoReply) {
      // A long-running turn: the message was claimed, but the turn never settles.
      return
    }
    agent.timer = setTimeout(finish, delayMs)
    agent.timer.unref?.()
  }

  function finish() {
    agent.timer = null
    agent.runs += 1
    agent.messages.push({ id: `reply-${agent.runs}-${id}`, role: 'assistant', content: [{ type: 'text', text: reply }] })
    agent.session.seq += 1
    agent.status = 'idle'
    if (agent.pending.length > 0) {
      agent.timer = setTimeout(claim, 5)
      agent.timer.unref?.()
    }
  }

  return agent
}

/** Fake Web/Desktop session controller. */
function makeController(agents, coldAgents = new Map()) {
  return {
    async list() {
      const live = [...agents.values()].map((agent, index) => ({
        sessionId: agent.id,
        updatedAt: 10_000 - index,
        running: agent.status === 'running',
        blank: agent.session.seq === 0,
        agentAvailable: true,
        cwd: agent.session.header.cwd,
        ...(typeof agent.session.header.origin === 'string' ? { origin: agent.session.header.origin } : {}),
        ...(typeof agent.session.header.parentSession === 'string' ? { parentSessionId: agent.session.header.parentSession } : {}),
        projections: { kind: 'sequenced', asOfSeq: 0, values: { title: { title: agent.title } } }
      }))
      const cold = [...coldAgents.values()].map((agent, index) => ({
        sessionId: agent.id,
        updatedAt: 5000 - index,
        running: false,
        blank: false,
        agentAvailable: false,
        cwd: agent.session.header.cwd,
        ...(typeof agent.session.header.origin === 'string' ? { origin: agent.session.header.origin } : {}),
        ...(typeof agent.session.header.parentSession === 'string' ? { parentSessionId: agent.session.header.parentSession } : {}),
        projections: { kind: 'cached', asOfSeq: 0, values: { title: { title: agent.title } } }
      }))
      return { items: [...live, ...cold] }
    },
    async resolveAgent(sessionId) {
      const agent = agents.get(sessionId) ?? coldAgents.get(sessionId)
      if (agent === undefined) return { error: { code: 'session/not-found', message: `no session ${sessionId}` } }
      if (!agents.has(sessionId)) agents.set(sessionId, agent)
      return { agent }
    }
  }
}

/** Fake `ctx.sessionQuery` (cold-safe corpus). */
function makeQuery({ records = [], titles = {}, surfaces = {}, headers = {} } = {}) {
  const headerOf = (sessionId) => headers[sessionId] ?? { version: 1, id: sessionId, createdAt: 1, isSeeded: false }
  return {
    async listSessions() {
      return records.map(({ header, live = false }) => ({ header: header ?? headerOf(header?.id ?? ''), live, persisted: true }))
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({
        sessionId,
        status: 'fulfilled',
        value: { session: headerOf(sessionId), ...(titles[sessionId] !== undefined ? { title: { title: titles[sessionId] } } : {}) }
      }))
    },
    async readTitle(sessionId) {
      return titles[sessionId] !== undefined ? { title: titles[sessionId] } : undefined
    },
    async readTitleSnapshot(sessionId) {
      return { session: headerOf(sessionId), ...(titles[sessionId] !== undefined ? { title: { title: titles[sessionId] } } : {}) }
    },
    async readSurface(sessionId) {
      return { session: headerOf(sessionId), inheritedEventCount: 0, capturedThroughSeq: null, events: surfaces[sessionId] ?? [] }
    }
  }
}

/** Apply the plugin to a fake context and return the registered tool table. */
function makeHost({ agents = new Map(), controller, query, sessions, resume, config, webServer, connection } = {}) {
  const tools = new Map()
  const listeners = new Map()
  const routes = []
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool registration: ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      }
    },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      ...(resume === undefined ? {} : { resume })
    },
    get(serviceName) {
      if (serviceName === 'sessionController') return controller
      if (serviceName === 'sessionQuery') return query
      if (serviceName === 'sessions') return sessions
      if (serviceName === 'webServer') return fakeWebServer
      if (serviceName === 'connection') return connection
      return undefined
    },
    on(eventName, listener) {
      const bucket = listeners.get(eventName) ?? []
      bucket.push(listener)
      listeners.set(eventName, bucket)
      return () => {
        const current = listeners.get(eventName) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    inject(deps, callback) {
      // Fake conditional injection: dependencies are already available here.
      callback(ctx)
    },
    effect(execute) {
      const cleanup = execute()
      return { dispose: async () => (typeof cleanup === 'function' ? cleanup() : undefined) }
    }
  }
  const fakeWebServer = webServer === undefined ? undefined : {
    register(route) {
      // The real Web server rejects duplicate path+kind registrations.
      if (routes.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
        throw new Error(`duplicate ${route.kind} route "${route.path}"`)
      }
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    }
  }
  apply(ctx, config)
  /** Fire one Host event at listeners registered by `apply`. */
  function fire(eventName, payload) {
    for (const listener of listeners.get(eventName) ?? []) listener(payload)
  }
  return { tools, ctx, routes, fire }
}

/** Call one registered tool with a caller Agent and an optional signal. */
async function callTool(host, name, args, { agent, signal } = {}) {
  const definition = host.tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  return definition.execute(args, { agent, signal: signal ?? new AbortController().signal })
}

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

const checks = []

async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function assertRejects(fn, pattern, message) {
  let caught
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  if (caught === undefined) throw new Error(`${message}: expected a rejection, but the call succeeded`)
  const text = String(caught?.message ?? caught)
  if (pattern !== undefined && !pattern.test(text)) throw new Error(`${message}: rejection did not match ${pattern}: ${text}`)
  return text
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Write the plugin's settings document for one test, restoring defaults afterwards. */
async function withSettings(value, run) {
  saveSettingsFile(settingsFilePath(process.env), value)
  try {
    await run()
  } finally {
    saveSettingsFile(settingsFilePath(process.env), { toolset: 'all', openAll: true, whitelist: [] })
  }
}

/** Minimal IncomingMessage stand-in for the settings route. */
function fakeRequest(url, method = 'GET', body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(String(body), 'utf8')])
  request.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  request.url = url
  request.method = method
  return request
}

/** Minimal ServerResponse stand-in for the settings route. */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
    }
  }
}

const SAMPLE_ARGS = {
  session_list: { query: 'build', limit: 5 },
  session_read: { session: 'session-b', limit: 5, final_only: false },
  session_ask: { session: 'session-b', message: 'status?', timeout_seconds: 30, mode: 'queue' },
  session_send: { session: 'session-b', message: 'heads up', mode: 'steer', force_insert: true }
}

/** Validate a tool's canonical output against its own declared schema (real validator when available). */
function assertValueShape(host, name, value) {
  if (realTools === undefined) return
  const definition = host.tools.get(name)
  const violations = realTools.validateJsonSchemaValue(definition.output.schema, value)
  assert(violations.length === 0, `${name} output violates its declared schema: ${violations.join('; ')}`)
}

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------

async function main() {
  // Isolate the settings document for this run (the plugin stores it under
  // $DSH_HOME/cross-session/settings.json).
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-cross-session-selfcheck-'))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
  saveSettingsFile(settingsFilePath(process.env), { toolset: 'all', openAll: true, whitelist: [] })

  const caller = makeFakeAgent('session-a', { title: 'Main chat', cwd: '/work/main' })

  await check('registers the four model-facing tools', async () => {
    const host = makeHost({ agents: new Map([[caller.id, caller]]), controller: makeController(new Map()) })
    assertEqual(host.tools.size, 4, 'registered tool count')
    for (const name of ['session_list', 'session_read', 'session_ask', 'session_send']) {
      const definition = host.tools.get(name)
      assert(definition !== undefined, `${name} is registered`)
      assert(typeof definition.description === 'string' && definition.description.length > 40, `${name} has a model-facing description`)
      assert(definition.parameters?.type === 'object', `${name} parameters are an object schema`)
      assert(typeof definition.output?.render === 'function', `${name} declares output.render`)
      assert(typeof definition.execute === 'function', `${name} declares execute`)
    }
  })

  await check('tool schemas pass the real dsh-tools validator (or are skipped)', async () => {
    if (realTools === undefined) return
    const host = makeHost({ agents: new Map([[caller.id, caller]]), controller: makeController(new Map()) })
    for (const [name, definition] of host.tools) {
      realTools.assertSupportedJsonSchema(definition.parameters)
      realTools.assertSupportedJsonSchema(definition.output.schema)
      const violations = realTools.validateJsonSchemaValue(definition.parameters, SAMPLE_ARGS[name])
      assert(violations.length === 0, `${name} rejects its own sample args: ${violations.join('; ')}`)
      const missing = realTools.validateJsonSchemaValue(definition.parameters, {})
      if (name !== 'session_list') assert(missing.length > 0, `${name} accepts missing required arguments`)
    }
  })

  await check('session_list reports live sessions with titles and the self flag', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline' })
    const blank = makeFakeAgent('session-c', { title: '' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer],
      [blank.id, blank]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const value = await callTool(host, 'session_list', { limit: 10 }, { agent: caller })
    assertValueShape(host, 'session_list', value)
    assertEqual(value.total, 3, 'listed session count')
    const self = value.sessions.find((row) => row.sessionId === caller.id)
    assert(self?.self === true, 'the caller row is marked self')
    const found = value.sessions.find((row) => row.sessionId === peer.id)
    assertEqual(found?.title, 'Build pipeline', 'peer title is projected')
    assertEqual(found?.live, true, 'peer is live')
    const rendered = host.tools.get('session_list').output.render({}, value)
    assert(rendered[0].text.includes('Build pipeline'), 'rendered list mentions the peer title')
  })

  await check('session_ask delivers a relay message and returns the answer', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', reply: 'all green' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const value = await callTool(host, 'session_ask', { session: 'Build pipeline', message: 'Is the migration done?' }, { agent: caller })
    assertValueShape(host, 'session_ask', value)
    assertEqual(value.sessionId, peer.id, 'answered session id')
    assertEqual(value.settled, true, 'turn settled')
    assertEqual(value.timedOut, false, 'not timed out')
    assertEqual(value.reply, 'all green', 'reply text')
    const relay = peer.messages.find((message) => message.role === 'user')
    assert(relay !== undefined, 'the peer received a user message')
    assertEqual(relay.source?.kind, 'agent-message', 'relay source kind')
    assertEqual(relay.source?.form, 'relay', 'relay source form')
    assertEqual(relay.source?.senderSessionId, caller.id, 'relay sender attribution')
    assert(relay.content[0].text.includes('Is the migration done?'), 'relay body carries the message')
    assert(relay.content[0].text.includes(caller.id), 'relay prefix names the sender session')
    const rendered = host.tools.get('session_ask').output.render({}, value)
    assert(rendered[0].text.includes('all green'), 'rendered answer includes the reply')
  })

  await check('the relay message is accepted by the real durable-session validator (or is skipped)', async () => {
    if (realSession === undefined) return
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', reply: 'ok' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    await callTool(host, 'session_ask', { session: peer.id, message: 'ping' }, { agent: caller })
    const relay = peer.messages.find((message) => message.role === 'user')
    assert(relay !== undefined, 'captured relay message')
    const adopted = realSession.adoptSessionEvent({ type: 'user/message', seq: 0, time: Date.now(), data: relay, surfaceOp: 'append' })
    assert(Object.isFrozen(adopted.data), 'the validator deep-froze the accepted message')
  })

  await check('session_read projects only user/assistant rows', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', reply: 'all green' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    await callTool(host, 'session_ask', { session: peer.id, message: 'status?' }, { agent: caller })
    // A live session's derived history also carries non-conversation roles; the
    // transcript view must never emit them (its output schema allows two roles).
    peer.messages.unshift(
      { id: 'system-1', role: 'system', content: [{ type: 'text', text: 'rendered system prompt' }] },
      { id: 'developer-1', role: 'developer', content: [{ type: 'tool-addition', toolName: 'bash' }] },
      { id: 'tool-1', role: 'tool', content: [{ type: 'text', text: 'tool output' }], toolCallId: 'call-1' }
    )
    const value = await callTool(host, 'session_read', { session: peer.id }, { agent: caller })
    assertValueShape(host, 'session_read', value)
    assert(value.messages.every((message) => message.role === 'user' || message.role === 'assistant'), 'only user/assistant roles')
    const roles = value.messages.map((message) => message.role)
    assert(roles.includes('user') && roles.includes('assistant'), 'transcript has user and assistant rows')
    const relayRow = value.messages.find((message) => message.role === 'user')
    assertEqual(relayRow?.from, caller.id, 'relay row names the sending session')
    assert(relayRow.text.includes('status?'), 'transcript includes the relayed question')
  })

  await check('session_read drops chain of thought (blocks and inline wrappers)', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline' })
    peer.messages.push(
      { id: 'relay-cot', role: 'user', content: [{ type: 'text', text: 'explain the failure' }], source: { kind: 'user' } },
      {
        id: 'answer-cot',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'SECRET-CHAIN-OF-THOUGHT: try A, then B' },
          { type: 'text', text: 'The answer is B.' }
        ]
      },
      {
        id: 'answer-inline',
        role: 'assistant',
        content: [{ type: 'text', text: '<thinking>hidden chain</thinking>\nVisible summary line.' }]
      }
    )
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const value = await callTool(host, 'session_read', { session: peer.id }, { agent: caller })
    assertValueShape(host, 'session_read', value)
    const transcript = value.messages.map((message) => message.text).join('\n')
    assert(!transcript.includes('SECRET-CHAIN-OF-THOUGHT'), 'reasoning blocks never reach the transcript')
    assert(!transcript.includes('hidden chain'), 'inline thinking wrappers are stripped')
    assert(transcript.includes('The answer is B.'), 'visible answer text survives')
    assert(transcript.includes('Visible summary line.'), 'text outside the wrapper survives')
  })

  await check('session_read final_only returns just the last answer', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline' })
    peer.messages.push(
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } },
      { id: 'a2', role: 'assistant', content: [{ type: 'reasoning', text: 'chain' }, { type: 'text', text: 'final answer' }] }
    )
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const value = await callTool(host, 'session_read', { session: peer.id, final_only: true }, { agent: caller })
    assertValueShape(host, 'session_read', value)
    assertEqual(value.messages.length, 1, 'final_only returns exactly one row')
    assertEqual(value.messages[0].role, 'assistant', 'final_only row is an assistant answer')
    assertEqual(value.messages[0].text, 'final answer', 'final_only returns the last visible answer')
    assertEqual(value.truncated, false, 'final_only is not a paged transcript')
    const rendered = host.tools.get('session_read').output.render({ final_only: true }, value)
    assert(rendered[0].text.includes('final output'), 'render labels the final-output mode')
  })

  await check('session_send delivers without waiting', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', delayMs: 10_000 })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const value = await callTool(host, 'session_send', { session: peer.id, message: 'heads up' }, { agent: caller })
    assertValueShape(host, 'session_send', value)
    assertEqual(value.delivered, true, 'delivered flag')
    assertEqual(value.mode, 'queue', 'default delivery mode')
    assertEqual(value.interrupted, false, 'ordinary delivery does not interrupt')
    assertEqual(peer.pending.length + peer.messages.length, 1, 'exactly one message entered the target')
    assert(host.tools.get('session_send').output.render({}, value)[0].text.includes('delivered'), 'render confirms delivery')
  })

  await check('session_send force_insert interrupts a running target and puts the message first', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', reply: 'urgent ack' })
    // Simulate a long running turn (the fake agent is mid-activity).
    peer.status = 'running'
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const value = await callTool(
      host,
      'session_send',
      { session: peer.id, message: 'URGENT: stop and read this now', force_insert: true },
      { agent: caller }
    )
    assertValueShape(host, 'session_send', value)
    assertEqual(value.interrupted, true, 'the running turn is reported as interrupted')
    assert(peer.cancelled !== null, 'the target agent was cancelled')
    assertEqual(peer.cancelled.cause.kind, 'user', 'the interrupt uses the user-authority cause')
    assertEqual(peer.cancelled.options.keepInbox, true, "the target's own queued input is preserved")
    assert(peer.inbox.removed.includes(value.messageId), 'the appended urgent message is moved out of the tail')
    assertEqual(peer.inbox.prepended.length, 1, 'the urgent message is prepended once')
    assertEqual(peer.inbox.prepended[0].target, 'next-turn', 'it is prepended to the next-turn queue')
    assertEqual(peer.inbox.prepended[0].message.id, value.messageId, 'the prepended message is the urgent relay')
    const delivered = [...peer.messages, ...peer.pending]
    const relay = delivered.find((message) => message.role === 'user')
    assert(relay !== undefined, 'the urgent message entered the target inbox')
    assert(relay.content[0].text.includes('interrupted your current turn'), 'urgent guidance is model-visible')
    assert(host.tools.get('session_send').output.render({}, value)[0].text.includes('interrupted'), 'render reports the interrupt')
    const rendered = host.tools.get('session_send').output.render({}, value)
    assert(rendered[0].text.includes('next turn'), 'render explains the message is the next turn')
  })

  await check('session_send force_insert on an idle target does not interrupt', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', reply: 'normal ack' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const value = await callTool(host, 'session_send', { session: peer.id, message: 'just in case', force_insert: true }, { agent: caller })
    assertValueShape(host, 'session_send', value)
    assertEqual(value.interrupted, false, 'an idle target is not cancelled')
    assertEqual(peer.cancelled, null, 'no cancel call on an idle target')
    assertEqual(peer.inbox.removed.length, 0, 'no queue reordering on an idle target')
    assertEqual(peer.pending.length + peer.messages.length, 1, 'the message still entered the target inbox')
    const relay = [...peer.messages, ...peer.pending].find((message) => message.role === 'user')
    assert(relay !== undefined, 'captured the delivered message')
    assert(!relay.content[0].text.includes('interrupted your current turn'), 'idle delivery must not claim an interrupt')
    assert(relay.content[0].text.includes('No reply is being waited on'), 'idle delivery uses the ordinary no-reply guidance')
  })

  await check('refuses to relay into the calling session itself', async () => {
    const agents = new Map([[caller.id, caller]])
    const host = makeHost({ agents, controller: makeController(agents) })
    await assertRejects(
      () => callTool(host, 'session_ask', { session: caller.id, message: 'hello me' }, { agent: caller }),
      /current session/,
      'self relay is refused'
    )
  })

  await check('refuses delegated subagent callers', async () => {
    const subagent = makeFakeAgent('session-child', { header: { origin: 'subagent', parentSession: caller.id } })
    const agents = new Map([
      [caller.id, caller],
      [subagent.id, subagent]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    await assertRejects(
      () => callTool(host, 'session_list', {}, { agent: subagent }),
      /top-level sessions only/,
      'subagent caller is refused'
    )
  })

  await check('refuses ambiguous titles and names the candidates', async () => {
    const one = makeFakeAgent('session-x', { title: 'Same title' })
    const two = makeFakeAgent('session-y', { title: 'Same title' })
    const agents = new Map([
      [caller.id, caller],
      [one.id, one],
      [two.id, two]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const text = await assertRejects(
      () => callTool(host, 'session_ask', { session: 'Same title', message: 'hi' }, { agent: caller }),
      /ambiguous/,
      'ambiguous title is refused'
    )
    assert(text.includes('session-x') && text.includes('session-y'), 'candidates are listed')
  })

  await check('cold session resumes through the deployment controller', async () => {
    const cold = makeFakeAgent('session-cold', { title: 'Cold topic', reply: 'resumed answer' })
    const agents = new Map([[caller.id, caller]])
    const host = makeHost({ agents, controller: makeController(agents, new Map([[cold.id, cold]])) })
    const value = await callTool(host, 'session_ask', { session: cold.id, message: 'wake up' }, { agent: caller })
    assertEqual(value.settled, true, 'cold turn settled after resume')
    assertEqual(value.reply, 'resumed answer', 'cold session answer')
    assert(agents.has(cold.id), 'the controller published the resumed agent')
  })

  await check('cold session without a controller refuses a preset session', async () => {
    const headers = { 'session-preset': { version: 1, id: 'session-preset', createdAt: 1, isSeeded: false, agentPreset: 'coder' } }
    const query = makeQuery({ records: [{ header: headers['session-preset'] }], titles: { 'session-preset': 'Preset session' }, headers })
    const agents = new Map([[caller.id, caller]])
    const host = makeHost({ agents, query })
    await assertRejects(
      () => callTool(host, 'session_ask', { session: 'session-preset', message: 'hi' }, { agent: caller }),
      /agent preset/,
      'preset session without composition is refused'
    )
  })

  await check('cold session falls back to the generic agent registry resume', async () => {
    const cold = makeFakeAgent('session-plain', { title: 'Plain session', reply: 'generic resume works' })
    const headers = { 'session-plain': { version: 1, id: 'session-plain', createdAt: 1, isSeeded: false } }
    const query = makeQuery({ records: [{ header: headers['session-plain'] }], titles: { 'session-plain': 'Plain session' }, headers })
    const agents = new Map([[caller.id, caller]])
    const host = makeHost({
      agents,
      query,
      resume: async ({ resumeSessionId }) => {
        assertEqual(resumeSessionId, cold.id, 'registry resume target')
        agents.set(cold.id, cold)
        return { agent: cold }
      }
    })
    const value = await callTool(host, 'session_ask', { session: 'session-plain', message: 'hello' }, { agent: caller })
    assertEqual(value.reply, 'generic resume works', 'generic resume answer')
  })

  await check('cold session without any resume capability fails with an explanation', async () => {
    const headers = { 'session-dead': { version: 1, id: 'session-dead', createdAt: 1, isSeeded: false } }
    const query = makeQuery({ records: [{ header: headers['session-dead'] }], headers })
    const agents = new Map([[caller.id, caller]])
    const host = makeHost({ agents, query })
    await assertRejects(
      () => callTool(host, 'session_ask', { session: 'session-dead', message: 'hi' }, { agent: caller }),
      /cannot resume/,
      'missing resume capability is reported'
    )
  })

  await check('cold-safe listing and reading work through the query tier', async () => {
    const relay = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'Cross-session message from session-a:\n\nold question' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id }
    }
    const reply = { id: 'cold-reply', role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }
    const headers = { 'session-cold': { version: 1, id: 'session-cold', createdAt: 5, isSeeded: false, cwd: '/work/cold' } }
    const query = makeQuery({
      records: [{ header: headers['session-cold'] }],
      titles: { 'session-cold': 'Archived work' },
      headers,
      surfaces: {
        'session-cold': [
          { type: 'user/message', data: relay },
          { type: 'assistant/message', data: { message: reply } }
        ]
      }
    })
    const agents = new Map([[caller.id, caller]])
    const host = makeHost({ agents, query })
    const listed = await callTool(host, 'session_list', {}, { agent: caller })
    assertValueShape(host, 'session_list', listed)
    const row = listed.sessions.find((candidate) => candidate.sessionId === 'session-cold')
    assert(row !== undefined, 'cold session is listed')
    assertEqual(row.title, 'Archived work', 'cold title comes from the query tier')
    assertEqual(row.live, false, 'cold session is not live')
    const read = await callTool(host, 'session_read', { session: 'session-cold' }, { agent: caller })
    assertValueShape(host, 'session_read', read)
    assertEqual(read.messages.length, 2, 'cold transcript rows')
    assertEqual(read.messages[0].from, caller.id, 'cold relay attribution is preserved')
    assertEqual(read.messages[1].text, 'old answer', 'cold assistant text')
  })

  await check('refuses a conversation that exceeds the relay hop budget', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', reply: 'still here' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    let lastError
    for (let hop = 0; hop < 7; hop += 1) {
      const sender = hop % 2 === 0 ? caller : peer
      const target = hop % 2 === 0 ? peer.id : caller.id
      try {
        await callTool(host, 'session_ask', { session: target, message: `hop ${hop}` }, { agent: sender })
      } catch (error) {
        lastError = error
        break
      }
    }
    assert(lastError !== undefined, 'the hop budget eventually rejects')
    assert(/hop limit/.test(String(lastError.message)), `hop limit error expected, got: ${lastError.message}`)
  })

  await check('session_ask times out without cancelling the target', async () => {
    const silent = makeFakeAgent('session-silent', { title: 'Silent', autoReply: false })
    const agents = new Map([
      [caller.id, caller],
      [silent.id, silent]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const started = Date.now()
    const value = await callTool(host, 'session_ask', { session: silent.id, message: 'still there?', timeout_seconds: 5 }, { agent: caller })
    const elapsed = Date.now() - started
    assertValueShape(host, 'session_ask', value)
    assertEqual(value.settled, false, 'timed-out ask is unsettled')
    assertEqual(value.timedOut, true, 'timedOut flag')
    assert(elapsed >= 4500, `the wait honoured the timeout floor (waited ${elapsed}ms)`)
    assert(silent.messages.some((message) => message.role === 'user'), 'the message stayed delivered')
    assert(host.tools.get('session_ask').output.render({}, value)[0].text.includes('no final answer'), 'render explains the timeout')
  })

  await check('cancelling the caller stops the wait but keeps the delivery', async () => {
    const silent = makeFakeAgent('session-silent', { title: 'Silent', autoReply: false })
    const agents = new Map([
      [caller.id, caller],
      [silent.id, silent]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const controller = new AbortController()
    const pending = callTool(host, 'session_ask', { session: silent.id, message: 'ping' }, { agent: caller, signal: controller.signal })
    await sleep(100)
    controller.abort()
    await assertRejects(() => pending, undefined, 'the wait honours caller cancellation')
    await sleep(50)
    assert(silent.messages.some((message) => message.role === 'user'), 'the delivery survived cancellation')
  })

  await check('live-only deployments work through the agent registry tier', async () => {
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline', reply: 'live only' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer]
    ])
    const host = makeHost({ agents })
    const listed = await callTool(host, 'session_list', {}, { agent: caller })
    assertEqual(listed.total, 2, 'live registry listing count')
    assert(listed.sessions.every((row) => row.live), 'registry tier rows are live')
    const value = await callTool(host, 'session_ask', { session: peer.id, message: 'hi' }, { agent: caller })
    assertEqual(value.reply, 'live only', 'live-only answer')
  })

  await check('list-only tier does not leak subagent child sessions', async () => {
    const child = makeFakeAgent('session-child', { header: { origin: 'subagent', parentSession: caller.id } })
    const peer = makeFakeAgent('session-b', { title: 'Build pipeline' })
    const agents = new Map([
      [caller.id, caller],
      [peer.id, peer],
      [child.id, child]
    ])
    const host = makeHost({ agents, controller: makeController(agents) })
    const listed = await callTool(host, 'session_list', {}, { agent: caller })
    assert(listed.sessions.every((row) => row.sessionId !== child.id), 'subagent child is hidden by default')
    const withChildren = await callTool(host, 'session_list', { include_subagents: true }, { agent: caller })
    assert(withChildren.sessions.some((row) => row.sessionId === child.id), 'include_subagents reveals it')
  })

  // -------------------------------------------------------------------------
  // Settings: pure policy, per-agent tool visibility, and the JSON routes.
  // -------------------------------------------------------------------------

  await check('normalizeSettings coerces malformed input to a valid value', async () => {
    const fromJunk = normalizeSettings(null)
    assertEqual(fromJunk.toolset, 'all', 'default toolset')
    assertEqual(fromJunk.openAll, true, 'default openAll')
    assertEqual(fromJunk.whitelist.length, 0, 'default empty whitelist')
    const fromPartial = normalizeSettings({ toolset: 'send-only', openAll: 'yes', whitelist: ['a', 'a', 42, '', 'b'] })
    assertEqual(fromPartial.toolset, 'send-only', 'explicit toolset is kept')
    assertEqual(fromPartial.openAll, true, 'only literal false disables openAll')
    assertEqual(fromPartial.whitelist.join(','), 'a,b', 'whitelist dedupes and drops non-strings')
    assertEqual(normalizeSettings({ toolset: 'bogus' }).toolset, 'all', 'unknown toolset falls back')
  })

  await check('deniedToolsFor implements toolset, whitelist and openAll', async () => {
    assertEqual(deniedToolsFor({ toolset: 'all', openAll: true, whitelist: [] }, 'session-a').length, 0, 'open-all/all hides nothing')
    const sendOnly = deniedToolsFor({ toolset: 'send-only', openAll: true, whitelist: [] }, 'session-a')
    assertEqual(sendOnly.length, 3, 'send-only hides three tools')
    assert(sendOnly.includes('session_list') && sendOnly.includes('session_read') && sendOnly.includes('session_ask'), 'send-only hides list/read/ask')
    assert(!sendOnly.includes('session_send'), 'send-only keeps session_send')
    assertEqual(deniedToolsFor({ toolset: 'all', openAll: false, whitelist: ['session-a'] }, 'session-a').length, 0, 'whitelisted session keeps everything')
    assertEqual(deniedToolsFor({ toolset: 'all', openAll: false, whitelist: ['session-a'] }, 'session-b').length, 4, 'unlisted session loses everything')
    const unlistedSendOnly = deniedToolsFor({ toolset: 'send-only', openAll: false, whitelist: [] }, 'session-b')
    assertEqual(unlistedSendOnly.length, 4, 'unlisted session loses everything even in send-only mode')
  })

  await check('startup settings apply per-agent tool restrictions', async () => {
    await withSettings({ toolset: 'send-only', openAll: true, whitelist: [] }, async () => {
      const agent = makeFakeAgent('session-a', { title: 'Main chat' })
      const host = makeHost({ agents: new Map([[agent.id, agent]]), controller: makeController(new Map()) })
      assertEqual(agent.restrictCalls.length, 1, 'restriction applied at startup')
      assertEqual(agent.restrictCalls[0].deny.join(','), 'session_list,session_read,session_ask', 'send-only deny list')
      assertEqual(host.tools.size, 4, 'tools stay registered globally; restriction is per agent')
    })
  })

  await check('whitelist restricts unlisted sessions at startup', async () => {
    await withSettings({ toolset: 'all', openAll: false, whitelist: ['session-a'] }, async () => {
      const allowed = makeFakeAgent('session-a', { title: 'Allowed' })
      const denied = makeFakeAgent('session-b', { title: 'Denied' })
      const agents = new Map([
        [allowed.id, allowed],
        [denied.id, denied]
      ])
      makeHost({ agents, controller: makeController(agents) })
      assertEqual(allowed.restrictCalls.length, 0, 'whitelisted session keeps all tools')
      assertEqual(denied.restrictCalls.length, 1, 'unlisted session is restricted')
      assertEqual(denied.restrictCalls[0].deny.length, 4, 'unlisted session loses all four tools')
    })
  })

  await check('agent/created applies the current settings to new agents', async () => {
    await withSettings({ toolset: 'all', openAll: false, whitelist: ['session-a'] }, async () => {
      const agents = new Map()
      const host = makeHost({ agents, controller: makeController(agents) })
      const created = makeFakeAgent('session-new', { title: 'New agent' })
      agents.set(created.id, created)
      host.fire('agent/created', { agent: created })
      assertEqual(created.restrictCalls.length, 1, 'new agent received the policy')
      assertEqual(created.restrictCalls[0].deny.length, 4, 'new unlisted agent loses all four tools')
      host.fire('agent/disposed', { agent: created })
      assertEqual(created.restrictDisposed, 1, 'disposal lifts the restriction')
    })
  })

  await check('internal subagents never see the tools', async () => {
    await withSettings({ toolset: 'all', openAll: true, whitelist: [] }, async () => {
      const root = makeFakeAgent('session-root', { title: 'Root chat' })
      const child = makeFakeAgent('session-child', { title: 'Delegated child', header: { origin: 'subagent', parentSession: 'session-root' } })
      const agents = new Map([
        [root.id, root],
        [child.id, child]
      ])
      makeHost({ agents, controller: makeController(agents) })
      assertEqual(root.restrictCalls.length, 0, 'an open root session keeps the tools')
      assertEqual(child.restrictCalls.length, 1, 'a delegated subagent is restricted')
      assertEqual(child.restrictCalls[0].deny.length, 4, 'a delegated subagent loses all four tools')
    })
  })

  await check('settings routes read, persist and re-apply policy', async () => {
    await withSettings({ toolset: 'all', openAll: true, whitelist: [] }, async () => {
      const a = makeFakeAgent('session-a', { title: 'Main chat' })
      const b = makeFakeAgent('session-b', { title: 'Build pipeline' })
      const agents = new Map([
        [a.id, a],
        [b.id, b]
      ])
      const host = makeHost({ agents, controller: makeController(agents), webServer: {} })
      assertEqual(host.routes.length, 1, 'one settings route registered')
      const route = host.routes[0]
      assertEqual(route.kind, 'exact', 'exact route')
      assertEqual(route.path, '/api/cross-session/settings', 'route path')

      const getResponse = fakeResponse()
      await route.handler(fakeRequest('/api/cross-session/settings', 'GET'), getResponse)
      const loaded = JSON.parse(getResponse.body)
      assertEqual(loaded.ok, true, 'GET succeeds')
      assertEqual(loaded.value.toolset, 'all', 'GET returns the default toolset')

      const postResponse = fakeResponse()
      await route.handler(
        fakeRequest('/api/cross-session/settings', 'POST', JSON.stringify({ toolset: 'send-only', openAll: false, whitelist: ['session-a'] })),
        postResponse
      )
      const saved = JSON.parse(postResponse.body)
      assertEqual(saved.ok, true, 'POST succeeds')
      assertEqual(saved.value.toolset, 'send-only', 'POST returns the stored toolset')
      assertEqual(saved.value.openAll, false, 'POST returns the stored scope')
      assertEqual(saved.value.whitelist.join(','), 'session-a', 'POST returns the stored whitelist')

      const stored = loadSettingsFile(settingsFilePath(process.env))
      assertEqual(stored.openAll, false, 'settings file persisted the scope')
      assertEqual(a.restrictCalls.at(-1).deny.length, 3, 'whitelisted session keeps send-only visibility')
      assertEqual(b.restrictCalls.at(-1).deny.length, 4, 'unlisted session lost all tools immediately')

      const badResponse = fakeResponse()
      await route.handler(fakeRequest('/api/cross-session/settings', 'POST', '{not json'), badResponse)
      assertEqual(badResponse.statusCode, 400, 'malformed body is rejected')
      assertEqual(JSON.parse(badResponse.body).ok, false, 'malformed body reports ok:false')
    })
  })

  // Isolated settings home is no longer needed.
  rmSync(tempHome, { recursive: true, force: true })
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome

  // -------------------------------------------------------------------------
  // Report.
  // -------------------------------------------------------------------------
  const failures = checks.filter((entry) => !entry.ok)
  for (const entry of checks) {
    const marker = entry.ok ? 'PASS' : 'FAIL'
    process.stdout.write(`[${marker}] ${entry.name}\n`)
    if (!entry.ok) process.stdout.write(`       ${String(entry.error?.stack ?? entry.error).split('\n').join('\n       ')}\n`)
  }
  process.stdout.write(
    `\n${checks.length - failures.length}/${checks.length} checks passed` +
      ` (external cross-checks: dsh-tools ${external.tools ? 'on' : 'skipped'}, dsh-session ${external.session ? 'on' : 'skipped'})\n`
  )
  process.exitCode = failures.length === 0 ? 0 : 1
}

await main()

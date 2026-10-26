/**
 * dsh-cross-session settings: pure policy + a small JSON file store.
 *
 * Kept apart from `index.js` so the visibility policy (which tools one session
 * may see) can be unit-tested without a Host, and so both the Host and the
 * self-check import the exact same rules.
 *
 * Settings shape:
 *   {
 *     toolset: 'all' | 'send-only',   // which tools the plugin exposes
 *     openAll: boolean,               // true = every session, false = whitelist only
 *     whitelist: string[]             // session ids allowed when openAll is false
 *   }
 *
 * @module dsh-cross-session/settings
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Every tool this plugin can expose. */
export const TOOL_NAMES = Object.freeze(['session_list', 'session_read', 'session_ask', 'session_send'])

/** Tools hidden when the deployment is limited to fire-and-forget delivery. */
export const SEND_ONLY_HIDDEN = Object.freeze(['session_list', 'session_read', 'session_ask'])

/** Built-in defaults: all four tools, every session allowed. */
export const DEFAULT_SETTINGS = Object.freeze({
  toolset: 'all',
  openAll: true,
  whitelist: Object.freeze([])
})

/** Upper bound on a persisted whitelist; keeps a malformed file from growing without limit. */
const MAX_WHITELIST = 500

/** Coerce arbitrary input into a complete, valid settings value. */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const toolset = source.toolset === 'send-only' ? 'send-only' : 'all'
  const openAll = source.openAll !== false
  const whitelist = []
  if (Array.isArray(source.whitelist)) {
    for (const entry of source.whitelist) {
      if (typeof entry !== 'string' || entry.length === 0) continue
      if (whitelist.includes(entry)) continue
      whitelist.push(entry)
      if (whitelist.length >= MAX_WHITELIST) break
    }
  }
  return { toolset, openAll, whitelist }
}

/**
 * Tools hidden from one session under the given settings.
 * @param settings - raw or normalized settings.
 * @param sessionId - identity of the agent's Session.
 * @returns tool names to deny; an empty array means the full toolset is visible.
 */
export function deniedToolsFor(settings, sessionId) {
  const normalized = normalizeSettings(settings)
  if (!normalized.openAll && !normalized.whitelist.includes(String(sessionId))) return [...TOOL_NAMES]
  return normalized.toolset === 'send-only' ? [...SEND_ONLY_HIDDEN] : []
}

/** Directory that owns this plugin's durable settings. */
export function settingsDirectory(env = process.env, home = homedir()) {
  const dshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, '.dsh')
  return join(dshHome, 'cross-session')
}

/** Absolute path of the settings JSON document. */
export function settingsFilePath(env = process.env, home = homedir()) {
  return join(settingsDirectory(env, home), 'settings.json')
}

/**
 * Read the settings document, falling back to defaults for any unreadable or
 * malformed state. A missing file is not an error: it means "first run".
 */
export function loadSettingsFile(file) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

/**
 * Persist one settings value atomically (temp file + rename), creating the home
 * directory on first write.
 * @param file - absolute settings path.
 * @param value - raw or normalized settings.
 * @returns the normalized value that was stored.
 */
export function saveSettingsFile(file, value) {
  const normalized = normalizeSettings(value)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return normalized
}

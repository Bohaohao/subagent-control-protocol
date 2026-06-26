// Bridge discovery file for the SCP status bridge.
//
// A desktop widget usually lives outside the MCP server process and outside the
// versioned plugin cache (which can be wiped/reinstalled). To connect to the
// optional localhost HTTP/SSE status bridge it needs a stable, predictable way
// to find the bridge's host/port and a few liveness facts. This module writes,
// reads, and removes a small `bridge.json` in a stable per-user location so the
// widget can discover the bridge without scraping ports or reading scheduler
// internals.
//
// The discovery file is intentionally minimal and contains no secrets:
//   schemaVersion - discovery schema version integer
//   schema        - stable schema tag (scp.bridge-discovery/v1)
//   host          - bind host the bridge is listening on
//   port          - bind port the bridge is listening on
//   startedAt     - ISO timestamp the bridge was started
//   pid           - OS pid of the bridge process, when available
//   workspace     - workspace path the bridge is reporting on, when provided
//   outputDir     - run output dir the bridge is reporting on, when provided
//   updatedAt     - ISO timestamp this file was last written
//
// resolveBridgeDiscoveryDir() turns an options object (env, an explicit dir,
// an outputDir/taskDir fallback) into a concrete directory path, preferring a
// stable user-data location over the plugin cache. It never creates
// directories - that only happens inside writeBridgeDiscovery(), and only when
// a file is actually being written.
//
// writeBridgeDiscovery() serializes the discovery payload to
// <dir>/bridge.json atomically: write to a temp file in the same directory,
// then rename. readBridgeDiscovery() reads it back tolerantly (missing/corrupt
// -> null). removeBridgeDiscovery() deletes it and tolerates a missing file.
//
// The discovery file is optional end-to-end: every entry point tolerates a
// missing directory option and returns a clear null/empty result instead of
// throwing. The bridge core never calls into this module - the runtime that
// owns the bridge handle wires write/remove around start/stop.
//
// No external dependencies. Node builtins only.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DISCOVERY_FILENAME = 'bridge.json'
const SCHEMA = 'scp.bridge-discovery/v1'
const SCHEMA_VERSION = 1

// Resolve the directory that should hold the bridge discovery file.
//
// Precedence (first non-empty wins):
//   1. options.discoveryDir - an explicit, operator-configured path.
//   2. SCP_BRIDGE_DISCOVERY_DIR env var.
//   3. A stable per-user data dir: <homedir>/.scp/bridge (or
//      %LOCALAPPDATA%\scp\bridge on Windows), so discovery survives plugin
//      cache reinstalls.
//   4. options.outputDir / options.taskDir - a run-local fallback so the
//      discovery file can be co-located with run artifacts when nothing better
//      is configured.
//
// Returns an absolute path or null when nothing usable is supplied. Never
// creates directories. `options.env` is injectable for deterministic testing;
// it defaults to process.env.
export function resolveBridgeDiscoveryDir(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env

  const explicit = nonEmptyString(options.discoveryDir) || nonEmptyString(env.SCP_BRIDGE_DISCOVERY_DIR)
  if (explicit) return path.resolve(explicit)

  const userData = defaultUserDataDir(env)
  if (userData) return path.join(userData, 'scp', 'bridge')

  const fallback = nonEmptyString(options.outputDir) || nonEmptyString(options.taskDir)
  return fallback ? path.resolve(fallback) : null
}

// Write the bridge discovery file atomically. `input` carries the bridge facts:
//   host, port, startedAt, pid?, workspace?, outputDir?
// plus optional `discoveryDir` / `env` / `outputDir` / `taskDir` for directory
// resolution. `updatedAt` defaults to now.
//
// Returns { ok, dir, path, updatedAt } on success, or
// { ok: false, error, dir } when no dir could be resolved or the write failed.
// Never throws.
export async function writeBridgeDiscovery(input = {}) {
  const dir = resolveBridgeDiscoveryDir(input)
  if (!dir) {
    return { ok: false, error: 'no bridge discovery directory configured', dir: null }
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    schema: SCHEMA,
    host: nonEmptyString(input.host) || null,
    port: normalizePort(input.port),
    startedAt: nonEmptyString(input.startedAt) || null,
    pid: normalizePid(input.pid),
    updatedAt: nonEmptyString(input.updatedAt) || new Date().toISOString(),
  }
  if (nonEmptyString(input.workspace)) payload.workspace = nonEmptyString(input.workspace)
  if (nonEmptyString(input.outputDir)) payload.outputDir = nonEmptyString(input.outputDir)

  const filePath = path.join(dir, DISCOVERY_FILENAME)
  try {
    await fs.mkdir(dir, { recursive: true })
    await writeAtomic(filePath, payload)
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), dir }
  }

  return { ok: true, dir, path: filePath, updatedAt: payload.updatedAt }
}

// Read the bridge discovery file. Returns the parsed payload, or null when the
// discovery dir is not configured, the file is missing, or it is
// unreadable/corrupt. Never throws.
export async function readBridgeDiscovery(options = {}) {
  const dir = resolveBridgeDiscoveryDir(options)
  if (!dir) return null

  const filePath = path.join(dir, DISCOVERY_FILENAME)
  let text
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

// Remove the bridge discovery file. Tolerates a missing dir or a missing file.
// Returns { ok: true, removed: boolean, dir } and never throws.
export async function removeBridgeDiscovery(options = {}) {
  const dir = resolveBridgeDiscoveryDir(options)
  if (!dir) return { ok: true, removed: false, dir: null }

  const filePath = path.join(dir, DISCOVERY_FILENAME)
  try {
    await fs.unlink(filePath)
    return { ok: true, removed: true, dir }
  } catch (error) {
    const code = error && error.code
    // Missing file is the desired post-condition; treat it as success.
    if (code === 'ENOENT') return { ok: true, removed: false, dir }
    return { ok: false, removed: false, dir, error: String(error && error.message ? error.message : error) }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Atomic-ish write: serialize to a temp file beside the destination, then
// rename over it. On Windows, fs.rename uses MoveFileExW with REPLACE_EXISTING,
// so a reader polling the destination never observes a half-written file. A
// unique temp suffix (pid + random) avoids collisions between concurrent
// writers.
async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + os.EOL, 'utf8')
  try {
    await fs.rename(tmp, filePath)
  } catch (error) {
    try {
      await fs.unlink(tmp)
    } catch {
      // Best-effort cleanup of the temp file; the original is untouched.
    }
    throw error
  }
}

function defaultUserDataDir(env) {
  // Windows: prefer %LOCALAPPDATA% (per-user, not roamed) so a plugin cache
  // reinstall under the marketplace directory does not take discovery with it.
  if (process.platform === 'win32') {
    const local = nonEmptyString(env.LOCALAPPDATA)
    if (local) return local
  }
  const home = nonEmptyString(env.HOME) || nonEmptyString(env.USERPROFILE)
  return home ? path.join(home, '.scp') : os.homedir() ? path.join(os.homedir(), '.scp') : null
}

function normalizePort(value) {
  if (value === null || value === undefined) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

function normalizePid(value) {
  if (value === null || value === undefined) {
    // Default to the current process when not explicitly supplied, so a widget
    // can correlate the discovery file to a live process. Callers may pass
    // null explicitly to suppress it.
    return typeof process.pid === 'number' ? process.pid : null
  }
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export { DISCOVERY_FILENAME, SCHEMA, SCHEMA_VERSION }

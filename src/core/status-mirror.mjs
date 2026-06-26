// Stable status mirror foundation for SCP.
//
// A desktop client often lives outside the MCP server process and outside the
// versioned plugin cache (which can be wiped/reinstalled). It needs a stable,
// predictable place to read the latest run status from, and the SCP runtime
// needs a safe way to publish that status without coupling to any particular UI.
//
// resolveStatusMirrorDir() turns an options object (env, an explicit dir, an
// SCP_TASK_DIR/SCP_RUN outputDir) into a concrete mirror directory path,
// preferring a stable user-data location over the plugin cache. It never
// creates directories - that only happens inside writeStatusMirror(), and only
// when a snapshot is actually being written.
//
// writeStatusMirror() serializes a RunViewModel (or any JSON-serializable
// status object) to <mirrorDir>/status.json atomically: write to a temp file in
// the same directory, then rename. It creates the mirror directory (and the
// temp file's parent) on demand but never deletes anything.
//
// readStatusMirror() reads the snapshot back tolerantly: a missing or corrupt
// file yields null rather than throwing, so a UI polling a not-yet-written
// mirror degrades cleanly.
//
// The mirror is optional end-to-end: every entry point tolerates a missing
// directory option and returns a clear null/empty result instead of throwing.
//
// No external dependencies. Node builtins only.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MIRROR_FILENAME = 'status.json'
const SCHEMA = 'scp.status-mirror/v1'

// Resolve the directory that should hold the status mirror.
//
// Precedence (first non-empty wins):
//   1. options.mirrorDir - an explicit, operator-configured path.
//   2. SCP_STATUS_MIRROR_DIR env var.
//   3. A stable per-user data dir: <homedir>/.scp/status (or %LOCALAPPDATA%\scp
//      on Windows), so the mirror survives plugin cache reinstalls.
//   4. options.outputDir / options.taskDir - a run-local fallback so a mirror
//      can be co-located with run artifacts when nothing better is configured.
//
// Returns an absolute path or null when nothing usable is supplied. Never
// creates directories. `options.env` is injectable for deterministic testing;
// it defaults to process.env.
export function resolveStatusMirrorDir(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env

  const explicit = nonEmptyString(options.mirrorDir) || nonEmptyString(env.SCP_STATUS_MIRROR_DIR)
  if (explicit) return path.resolve(explicit)

  const userData = defaultUserDataDir(env)
  if (userData) return path.join(userData, 'scp', 'status')

  const fallback = nonEmptyString(options.outputDir) || nonEmptyString(options.taskDir)
  return fallback ? path.resolve(fallback) : null
}

// Write a status snapshot to the mirror directory atomically. `input.snapshot`
// (or `input` itself if it is not a wrapper) is the JSON-serializable view
// model to persist. `input.mirrorDir` / `input.env` / `input.outputDir` /
// `input.taskDir` are passed to resolveStatusMirrorDir(). `input.runId` is
// stamped onto the envelope if present.
//
// Returns { ok, mirrorDir, path, updatedAt } on success, or
// { ok: false, error, mirrorDir } when no mirror dir could be resolved or the
// write failed. Never throws.
export async function writeStatusMirror(input = {}) {
  const mirrorDir = resolveStatusMirrorDir(input)
  if (!mirrorDir) {
    return { ok: false, error: 'no status mirror directory configured', mirrorDir: null }
  }

  const snapshot = input.snapshot !== undefined ? input.snapshot : input
  const envelope = {
    schema: SCHEMA,
    updatedAt: input.updatedAt || new Date().toISOString(),
    runId: input.runId || extractRunId(snapshot) || null,
    snapshot,
  }

  const filePath = path.join(mirrorDir, MIRROR_FILENAME)
  try {
    await fs.mkdir(mirrorDir, { recursive: true })
    await writeAtomic(filePath, envelope)
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), mirrorDir }
  }

  return {
    ok: true,
    mirrorDir,
    path: filePath,
    updatedAt: envelope.updatedAt,
  }
}

// Read the status snapshot from the mirror directory. Returns the parsed
// envelope (with `snapshot`), or null when the mirror is not configured, the
// file is missing, or it is unreadable/corrupt. Never throws.
export async function readStatusMirror(options = {}) {
  const mirrorDir = resolveStatusMirrorDir(options)
  if (!mirrorDir) return null

  const filePath = path.join(mirrorDir, MIRROR_FILENAME)
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
  // Normalize older or hand-written payloads: if there is no `snapshot` field,
  // treat the whole object as the snapshot so callers always see a `snapshot`.
  if (parsed.snapshot === undefined) {
    return { ...parsed, schema: parsed.schema || SCHEMA, snapshot: parsed }
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Atomic-ish write: serialize to a temp file beside the destination, then
// rename over it. On Windows, fs.rename uses MoveFileExW with REPLACE_EXISTING,
// so a reader polling the destination never observes a half-written file. A
// unique temp suffix (pid + random) avoids collisions between concurrent
// writers (e.g. the scheduler and a separate status publisher).
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
  // reinstall under the marketplace directory does not take the mirror with it.
  if (process.platform === 'win32') {
    const local = nonEmptyString(env.LOCALAPPDATA)
    if (local) return local
  }
  const home = nonEmptyString(env.HOME) || nonEmptyString(env.USERPROFILE)
  return home ? path.join(home, '.scp') : os.homedir() ? path.join(os.homedir(), '.scp') : null
}

function extractRunId(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return snapshot.runId || (snapshot.summary && snapshot.summary.runId) || null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

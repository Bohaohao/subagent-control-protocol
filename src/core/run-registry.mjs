import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readJson } from './json.mjs'

// Standalone run registry / recovery module (optimization point 5).
//
// The scheduler keeps active run handles in memory (activeRuns / retainedRuns in
// scheduler.mjs). Those maps are lost when the MCP server process restarts, so a
// runId that was started asynchronously can no longer be resolved. This module
// persists a compact run-handle registry to disk under outputDir and can rebuild
// it by scanning outputDir after a restart, classifying each run directory as
// active / completed / orphaned / recovered / unknown.
//
// It never manages child processes and never scans outside the outputDir it is
// given. All filesystem access is confined to outputDir and its direct run
// subdirectories.

const REGISTRY_FILENAME = '.scp-run-registry.json'

// A run whose latest heartbeat is older than this is considered stale: if it has
// no run-summary.json it is treated as orphaned (the owning process is gone)
// rather than active. Generous enough to absorb normal GC pauses, tight enough
// that a run killed by an MCP restart is flagged within minutes.
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000

// run-summary.json is only written when a run has ended (success, failure,
// cancellation, or the async failure-summary path). Presence of an endedAt on
// that summary is therefore the strongest "this run is finished" signal.
function hasEnded(summary) {
  return Boolean(summary && typeof summary === 'object' && summary.endedAt)
}

// Local mirror of scheduler.mjs deriveRunStatus. Kept private here so this
// module stays standalone (the scheduler does not export it). If the scheduler
// ever exports it, prefer importing to avoid drift.
function deriveRunStatus(summary) {
  if (!summary || typeof summary !== 'object') return 'unknown'
  if (typeof summary.status === 'string') return summary.status
  if (summary.error) return 'failed'
  if ((summary.cancelledTasks || 0) > 0) return 'cancelled'
  if ((summary.failedTasks || 0) > 0 || (summary.timedOutTasks || 0) > 0) return 'failed'
  if ((summary.blockedTasks || 0) > 0) return 'blocked'
  const total = summary.totalTasks || 0
  const finished = (summary.completedTasks || 0) + (summary.partialTasks || 0)
  if (total > 0 && finished >= total) return 'completed'
  return 'running'
}

function emptyRegistry(outputDir) {
  return { version: 1, outputDir: path.resolve(outputDir), updatedAt: null, runs: {} }
}

function registryPath(outputDir) {
  return path.join(path.resolve(outputDir), REGISTRY_FILENAME)
}

// Read the registry tolerantly: a missing file yields an empty registry, and a
// corrupt file yields an empty registry rather than throwing. Callers can rely
// on always getting a well-formed object back.
export async function readRunRegistry(outputDir) {
  const filePath = registryPath(outputDir)
  let parsed
  try {
    parsed = await readJson(filePath)
  } catch {
    return emptyRegistry(outputDir)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyRegistry(outputDir)
  }
  const runs = parsed.runs && typeof parsed.runs === 'object' && !Array.isArray(parsed.runs)
    ? parsed.runs
    : {}
  return {
    version: 1,
    outputDir: path.resolve(outputDir),
    updatedAt: parsed.updatedAt || null,
    runs,
  }
}

// Atomic-ish registry write: serialize to a temp file in the same directory,
// then rename over the destination. On Windows, fs.rename uses
// MoveFileExW with REPLACE_EXISTING, so the rename over an existing registry
// file is atomic from a reader's perspective. A unique temp suffix (pid + random)
// avoids collisions between concurrent writers.
async function writeRegistryAtomic(outputDir, registry) {
  const filePath = registryPath(outputDir)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const payload = {
    version: 1,
    outputDir: path.resolve(outputDir),
    updatedAt: new Date().toISOString(),
    runs: registry.runs || {},
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + os.EOL, 'utf8')
  try {
    await fs.rename(tmp, filePath)
  } catch (error) {
    // If the rename fails, try to clean up the temp file so we don't litter
    // outputDir on every write. The original registry (if any) is untouched.
    try {
      await fs.unlink(tmp)
    } catch {
      // Best-effort cleanup; ignore.
    }
    throw error
  }
  return payload
}

// Upsert a run handle into the registry. Existing fields for the runId are
// preserved and merged with the supplied entry. Pass { status } to record the
// current classification, or { markedStatus } for an explicit operator/scheduler
// mark such as 'active' or 'cancelled'.
export async function writeRunRegistryEntry(outputDir, entry = {}) {
  if (!entry || !entry.runId) {
    throw new Error('writeRunRegistryEntry requires entry.runId')
  }
  const registry = await readRunRegistry(outputDir)
  const existing = registry.runs[entry.runId] || {}
  const merged = {
    ...existing,
    ...entry,
    updatedAt: new Date().toISOString(),
  }
  // runDir is canonical when provided; otherwise keep whatever was stored.
  if (!merged.runDir && existing.runDir) merged.runDir = existing.runDir
  registry.runs[entry.runId] = merged
  await writeRegistryAtomic(outputDir, registry)
  return merged
}

// Apply an explicit status mark to a run (e.g. 'active' when the scheduler
// starts a run, 'completed'/'cancelled' when it ends). Creates a minimal entry
// if the runId is not yet known. `extra` is merged in for ad-hoc fields.
export async function markRunRegistryEntry(outputDir, runId, status, extra = {}) {
  if (!runId) throw new Error('markRunRegistryEntry requires runId')
  return writeRunRegistryEntry(outputDir, {
    runId,
    markedStatus: status,
    ...extra,
  })
}

// Resolve a runDir for a runId from the persisted registry. Returns null when
// the runId is unknown. Does not fall back to scanning outputDir - callers that
// want disk-truth should use recoverRunsFromOutputDir.
export async function resolveRunDirFromRegistry(outputDir, runId) {
  if (!runId) return null
  const registry = await readRunRegistry(outputDir)
  const entry = registry.runs[runId]
  return entry?.runDir || null
}

// Read a task's events.jsonl safely. Tolerates a missing file and skips
// malformed lines. Returns the list of parsed event objects (append-ordered).
async function readEventsFile(eventsPath) {
  let text
  try {
    text = await fs.readFile(eventsPath, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event)
    } catch {
      // Skip malformed line.
    }
  }
  return events
}

// Collect the task dirs to inspect for events. Prefers task results already
// carried in the summary; when no summary exists (run in progress), scans
// runDir/tasks. Never leaves runDir.
async function collectTaskEntries(summary, runDir) {
  const entries = []
  if (summary && Array.isArray(summary.tasks)) {
    for (const task of summary.tasks) {
      if (!task) continue
      entries.push({ id: task.id, taskDir: task.taskDir, eventLogPath: task.eventLogPath })
    }
  }
  if (entries.length === 0 && runDir) {
    const tasksDir = path.join(runDir, 'tasks')
    let names = []
    try {
      names = await fs.readdir(tasksDir, { withFileTypes: true })
    } catch {
      return entries
    }
    for (const ent of names) {
      if (!ent.isDirectory()) continue
      entries.push({ id: ent.name, taskDir: path.join(tasksDir, ent.name), eventLogPath: null })
    }
  }
  return entries
}

function eventTimestamp(event) {
  return event?.timestamp || event?.ts || null
}

// Latest heartbeat/Activity timestamp across all of a run's task event logs.
// Used to distinguish a genuinely active run (fresh heartbeat) from an orphaned
// one (stale or no heartbeat). Returns an ISO string or null.
async function latestHeartbeat(runDir, summary) {
  const entries = await collectTaskEntries(summary, runDir)
  let latest = null
  for (const entry of entries) {
    const eventsPath = entry.eventLogPath || (entry.taskDir ? path.join(entry.taskDir, 'events.jsonl') : null)
    if (!eventsPath) continue
    const events = await readEventsFile(eventsPath)
    for (const event of events) {
      const ts = eventTimestamp(event)
      if (ts && (!latest || ts > latest)) latest = ts
    }
  }
  return latest
}

// True when every task declared in run-input.json has a result.json on disk -
// i.e. the run progressed far enough to be reconstructable even though the
// summary write was interrupted. Mirrors the recoverSummaryFromTaskResults
// condition in scheduler.mjs.
async function allTaskResultsPresent(runDir, input) {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : []
  if (!tasks.length) return false
  for (const task of tasks) {
    if (!task?.id) return false
    try {
      await fs.access(path.join(runDir, 'tasks', task.id, 'result.json'))
    } catch {
      return false
    }
  }
  return true
}

// Gather the on-disk state for a single run directory. Each read is optional;
// missing files yield null rather than throwing.
async function gatherRunState(runDir) {
  let input = null
  let summary = null
  try {
    input = await readJson(path.join(runDir, 'run-input.json'))
  } catch {
    input = null
  }
  try {
    summary = await readJson(path.join(runDir, 'run-summary.json'))
  } catch {
    summary = null
  }
  const heartbeat = await latestHeartbeat(runDir, summary)
  return { runDir, input, summary, heartbeat }
}

// Determine whether a heartbeat timestamp is still fresh given a staleness
// window. `now` is injectable for deterministic testing.
function heartbeatIsFresh(heartbeat, staleAfterMs, now = Date.now()) {
  if (!heartbeat) return false
  const parsed = Date.parse(heartbeat)
  if (!Number.isFinite(parsed)) return false
  return now - parsed <= staleAfterMs
}

// Classify a run from its on-disk state. Returns one of:
//   active    - no terminal summary, but a fresh heartbeat (run still running)
//   completed - run-summary.json present with endedAt (run ended normally)
//   recovered - no summary and stale/absent heartbeat, but every task wrote a
//               result.json (summary write was interrupted; reconstructable)
//   orphaned  - no summary, stale/absent heartbeat, and not all results present
//               (run was interrupted mid-flight, e.g. by an MCP restart)
//   unknown   - neither run-input.json nor run-summary.json readable
//
// Disk is the source of truth: an explicit registry mark is not trusted over
// the files on disk. `options.now` and `options.staleAfterMs` are for testing.
export function classifyRun(state, options = {}) {
  const { summary, input } = state
  if (!summary && !input) return 'unknown'

  if (hasEnded(summary)) return 'completed'

  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const now = options.now ?? Date.now()
  if (heartbeatIsFresh(state.heartbeat, staleAfterMs, now)) return 'active'

  // No terminal summary and no fresh heartbeat. Decide recoverable vs orphaned
  // from whether all task results made it to disk.
  return state.allResultsPresent ? 'recovered' : 'orphaned'
}

// Scan outputDir for run directories, classify each, and rebuild the persisted
// registry. Only direct subdirectories of outputDir are inspected (never the
// parent or siblings), and only those that look like runs (having a
// run-input.json or run-summary.json) are classified - everything else is
// skipped so unrelated directories don't pollute the registry.
//
// Returns a summary of the recovery pass and writes the rebuilt registry to
// {outputDir}/.scp-run-registry.json.
export async function recoverRunsFromOutputDir(outputDir, options = {}) {
  const resolved = path.resolve(outputDir)
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const now = options.now ?? Date.now()

  let entries = []
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true })
  } catch {
    // outputDir itself doesn't exist: nothing to recover. Still return a valid
    // (empty) result rather than throwing.
    return {
      outputDir: resolved,
      registryPath: registryPath(resolved),
      runs: [],
      counts: { active: 0, completed: 0, recovered: 0, orphaned: 0, unknown: 0 },
      updatedAt: new Date().toISOString(),
    }
  }

  const runs = []
  const registry = emptyRegistry(resolved)

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runDir = path.join(resolved, entry.name)
    const state = await gatherRunState(runDir)
    if (!state.summary && !state.input) continue // not a run directory; skip

    const allResultsPresent = await allTaskResultsPresent(runDir, state.input)
    const classification = classifyRun(
      { ...state, allResultsPresent },
      { staleAfterMs, now },
    )
    const runId = (state.summary && state.summary.runId)
      || (state.input && state.input.runId)
      || entry.name
    const runStatus = state.summary ? deriveRunStatus(state.summary) : null

    const record = {
      runId,
      runDir,
      outputDir: resolved,
      startedAt: (state.input && state.input.startedAt)
        || (state.summary && state.summary.startedAt)
        || null,
      endedAt: (state.summary && state.summary.endedAt) || null,
      status: classification,
      runStatus,
      taskCount: (state.input && state.input.taskCount)
        || (state.summary && state.summary.totalTasks)
        || null,
      heartbeat: state.heartbeat,
      updatedAt: new Date().toISOString(),
    }
    runs.push(record)
    registry.runs[runId] = record
  }

  await writeRegistryAtomic(resolved, registry)

  const counts = { active: 0, completed: 0, recovered: 0, orphaned: 0, unknown: 0 }
  for (const run of runs) {
    if (counts[run.status] !== undefined) counts[run.status] += 1
  }

  return {
    outputDir: resolved,
    registryPath: registryPath(resolved),
    runs,
    counts,
    updatedAt: registry.updatedAt,
  }
}

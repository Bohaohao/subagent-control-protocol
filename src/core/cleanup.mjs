import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson } from './json.mjs'

// Cleanup/retention for .subagent-runs-like output directories. Each direct
// child of outputDir is treated as one run directory. Plans classify every run
// by reading its run-summary.json (when present) and computing size, age, and
// status; execution only ever removes run dirs that are verified direct
// children of outputDir, and only when dryRun is false.

const RUN_SUMMARY_FILE = 'run-summary.json'

const DEFAULT_OPTIONS = {
  dryRun: true,
  maxAgeDays: null,
  maxRuns: null,
  maxBytes: null,
  keepFailed: true,
  includeIncomplete: false,
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Merge caller options over the defaults, tolerating an undefined argument so
// callers can invoke planCleanup() / executeCleanup() with no options at all.
function normalizeOptions(options = {}) {
  const merged = { ...DEFAULT_OPTIONS }
  const source = options && typeof options === 'object' ? options : {}
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (source[key] !== undefined && source[key] !== null) {
      merged[key] = source[key]
    }
  }
  merged.dryRun = merged.dryRun !== false
  merged.keepFailed = merged.keepFailed !== false
  merged.includeIncomplete = Boolean(merged.includeIncomplete)
  merged.maxAgeDays = toPositiveNumber(merged.maxAgeDays)
  merged.maxRuns = toPositiveNumber(merged.maxRuns)
  merged.maxBytes = toPositiveNumber(merged.maxBytes)
  return merged
}

function toPositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return null
  return num
}

// True only when childDir resolves to a single path segment directly inside
// parentDir. Anything deeper, outside, or on another root is rejected - this is
// the guard that keeps fs.rm from ever touching paths outside outputDir.
function isDirectChild(parentDir, childDir) {
  const parent = path.resolve(parentDir)
  const child = path.resolve(childDir)
  if (child === parent) return false
  const rel = path.relative(parent, child)
  if (!rel) return false
  if (path.isAbsolute(rel)) return false
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false
  // A direct child has exactly one segment with no separator.
  return !rel.includes(path.sep)
}

// Infer a single run-level status from a run summary, mirroring the logic in
// scheduler.mjs's deriveRunStatus without importing a private helper. A missing
// summary means the run never finished writing one.
function deriveStatus(summary) {
  if (!summary || typeof summary !== 'object') return 'incomplete_or_unreadable'
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

function isIncomplete(status, summary) {
  if (!summary) return true
  return status === 'running' || status === 'unknown' || status === 'incomplete_or_unreadable'
}

// Pick the best available timestamp (ms since epoch) for age computation:
// summary.endedAt, then summary.startedAt, then the directory's mtime.
function runTimestampMs(summary, dirMtimeMs) {
  for (const candidate of [summary?.endedAt, summary?.startedAt]) {
    if (typeof candidate === 'string' && candidate) {
      const parsed = Date.parse(candidate)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return Number.isFinite(dirMtimeMs) ? dirMtimeMs : 0
}

// Recursive directory size in bytes. Symlinks are skipped to avoid double
// counting and to stay within outputDir; unreadable entries are ignored.
async function dirSizeBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else {
        try {
          const stat = await fs.stat(full)
          total += stat.size
        } catch {
          // Unreadable file: skip without aborting the whole measurement.
        }
      }
    }
  }
  return total
}

// Read every direct child directory of outputDir and classify it. Returns the
// resolved outputDir plus an array of run entries with a delete/keep action and
// a human-readable reason. This is shared by planCleanup (returned as-is) and
// executeCleanup (which then acts on the plan).
async function buildPlan(options) {
  const opts = normalizeOptions(options)
  const outputDir = path.resolve(String(options?.outputDir || path.join(process.cwd(), '.subagent-runs')))

  let entries = []
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true })
  } catch {
    return {
      outputDir,
      dryRun: opts.dryRun,
      options: opts,
      runs: [],
      summary: emptySummary(opts.dryRun),
    }
  }

  const now = Date.now()
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink?.()) continue
    if (!entry.isDirectory()) continue
    const runDir = path.join(outputDir, entry.name)
    if (!isDirectChild(outputDir, runDir)) continue

    let summary = null
    try {
      summary = await readJson(path.join(runDir, RUN_SUMMARY_FILE))
    } catch {
      // No summary yet (run in progress) or unreadable: treat as incomplete.
    }

    let dirMtimeMs = 0
    try {
      dirMtimeMs = (await fs.stat(runDir)).mtimeMs
    } catch {
      // Leave mtime at 0; age falls back to the summary timestamp.
    }

    const status = deriveStatus(summary)
    const timestampMs = runTimestampMs(summary, dirMtimeMs)
    const ageDays = timestampMs > 0 ? Math.max(0, (now - timestampMs) / MS_PER_DAY) : null
    const bytes = await dirSizeBytes(runDir)

    runs.push({
      runDir,
      name: entry.name,
      runId: summary?.runId || entry.name,
      status,
      startedAt: summary?.startedAt || null,
      endedAt: summary?.endedAt || null,
      ageDays,
      bytes,
      summary: summary ? { runId: summary.runId, status, startedAt: summary.startedAt, endedAt: summary.endedAt } : null,
      action: 'keep',
      reason: '',
    })
  }

  classify(runs, opts)

  return {
    outputDir,
    dryRun: opts.dryRun,
    options: opts,
    runs,
    summary: summarizePlan(runs, opts.dryRun),
  }
}

// Apply retention policies to the in-memory run entries, mutating each entry's
// action/reason. Protected runs (failed when keepFailed, incomplete when
// !includeIncomplete) are never marked for deletion by policy.
function classify(runs, opts) {
  for (const run of runs) {
    if (run.status === 'failed' && opts.keepFailed) {
      run.action = 'keep'
      run.reason = 'keepFailed'
      continue
    }
    if (isIncomplete(run.status, run.summary) && !opts.includeIncomplete) {
      run.action = 'keep'
      run.reason = 'incomplete (includeIncomplete=false)'
      continue
    }
  }

  // Candidates are non-protected runs that policy may delete.
  const candidates = runs.filter((run) => run.action !== 'keep' || run.reason === '')

  // maxAgeDays: any non-protected run older than the threshold is deletable.
  if (opts.maxAgeDays != null) {
    for (const run of candidates) {
      if (run.ageDays != null && run.ageDays > opts.maxAgeDays) {
        run.action = 'delete'
        run.reason = `older than maxAgeDays (${opts.maxAgeDays}d; age ${run.ageDays.toFixed(1)}d)`
      }
    }
  }

  // maxRuns: keep only the newest N runs overall. Older runs beyond the limit
  // become delete candidates (protected runs remain kept regardless).
  if (opts.maxRuns != null) {
    // Smaller ageDays === newer, so ascending age puts newest first.
    const byNewest = runs
      .slice()
      .sort((a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity))
    for (let i = opts.maxRuns; i < byNewest.length; i++) {
      const run = byNewest[i]
      if (run.action === 'delete') continue
      if (run.reason && run.reason !== '') continue // protected
      run.action = 'delete'
      run.reason = `exceeds maxRuns (${opts.maxRuns})`
    }
  }

  // maxBytes: reclaim space by deleting oldest non-protected runs until the
  // total of kept runs fits under the byte budget. Runs already marked delete
  // already count as reclaimed.
  if (opts.maxBytes != null) {
    let keptBytes = runs
      .filter((run) => run.action !== 'delete')
      .reduce((sum, run) => sum + (run.bytes || 0), 0)
    if (keptBytes > opts.maxBytes) {
      // Oldest non-protected, not-already-deleted runs first: largest ageDays.
      const byOldest = runs
        .filter((run) => run.action !== 'delete' && !(run.reason && run.reason !== ''))
        .sort((a, b) => (b.ageDays ?? -Infinity) - (a.ageDays ?? -Infinity))
      for (const run of byOldest) {
        if (keptBytes <= opts.maxBytes) break
        run.action = 'delete'
        run.reason = `exceeds maxBytes (${opts.maxBytes})`
        keptBytes -= run.bytes || 0
      }
    }
  }
}

function summarizePlan(runs, dryRun) {
  const deleteRuns = runs.filter((run) => run.action === 'delete')
  const reclaimedBytes = deleteRuns.reduce((sum, run) => sum + (run.bytes || 0), 0)
  return {
    totalRuns: runs.length,
    deleteCount: deleteRuns.length,
    keepCount: runs.length - deleteRuns.length,
    reclaimedBytes,
    dryRun,
  }
}

function emptySummary(dryRun) {
  return { totalRuns: 0, deleteCount: 0, keepCount: 0, reclaimedBytes: 0, dryRun }
}

// Classify every run directory under outputDir without deleting anything. Safe
// to call with dryRun true or false; planning never touches the filesystem
// beyond reading directories and run-summary.json files.
export async function planCleanup(options = {}) {
  return buildPlan(options)
}

// Execute the retention plan. When dryRun is true (the default) this only
// reports what would be deleted. When dryRun is false, each run marked for
// deletion is removed with fs.rm - but only after re-verifying it is a direct
// child of outputDir. Returns a structured summary.
export async function executeCleanup(options = {}) {
  const plan = await buildPlan(options)
  const dryRun = plan.dryRun
  const errors = []
  const deletedRuns = []
  const keptRuns = []

  for (const run of plan.runs) {
    if (run.action !== 'delete') {
      keptRuns.push(pickRun(run))
      continue
    }

    if (!isDirectChild(plan.outputDir, run.runDir)) {
      errors.push({
        runDir: run.runDir,
        error: 'refused: run dir is not a direct child of outputDir',
      })
      keptRuns.push(pickRun(run))
      continue
    }

    if (dryRun) {
      deletedRuns.push(pickRun(run))
      continue
    }

    try {
      await fs.rm(run.runDir, { recursive: true, force: false })
      deletedRuns.push(pickRun(run))
    } catch (error) {
      errors.push({ runDir: run.runDir, error: error?.message || String(error) })
      keptRuns.push(pickRun(run))
    }
  }

  const reclaimedBytes = deletedRuns.reduce((sum, run) => sum + (run.bytes || 0), 0)

  return {
    outputDir: plan.outputDir,
    deletedRuns,
    keptRuns,
    reclaimedBytes,
    dryRun,
    errors,
  }
}

// Project a run entry down to the fields callers care about in a result, so the
// internal action/reason bookkeeping doesn't leak more than is useful.
function pickRun(run) {
  return {
    runDir: run.runDir,
    runId: run.runId,
    name: run.name,
    status: run.status,
    ageDays: run.ageDays,
    bytes: run.bytes,
    reason: run.reason,
  }
}

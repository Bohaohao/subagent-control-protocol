import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cancelActiveRun, listActiveProcesses, resolveClaudeExecutable, runClaudeTask } from './claude-runner.mjs'
import { buildControllerSummary } from './controller-summary.mjs'
import { assessHeartbeat, summarizeEventList, trimEvent as trimProtocolEvent } from './event-protocol.mjs'
import { createRunId, readJson, writeJson } from './json.mjs'
import { validateRunFileOwnership } from './ownership.mjs'
import { readStatusMirror, resolveStatusMirrorDir, writeStatusMirror } from './status-mirror.mjs'
import { buildRunViewModel } from './status-view.mjs'
import {
  markRunRegistryEntry,
  recoverRunsFromOutputDir,
  resolveRunDirFromRegistry,
  writeRunRegistryEntry,
} from './run-registry.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const resultSchemaPath = path.join(packageRoot, 'schemas', 'agent-result.schema.json')

// runId -> active run metadata. Lets cancelRun() stop pending tasks, not just
// kill the currently-running Claude processes, and lets collectRun resolve a
// live async run from runId alone.
const activeRuns = new Map()
const retainedRuns = new Map()
const RETAINED_RUN_LIMIT = 100

export async function runTaskPlan(plan, options = {}) {
  const { scheduler, tasks } = await prepareRun(plan, options)
  activeRuns.set(scheduler.runId, scheduler.cancellation)
  try {
    return await executeRun(scheduler, tasks)
  } finally {
    activeRuns.delete(scheduler.runId)
  }
}

// Validate and prepare the same plan shape runTaskPlan uses, write
// run-input.json, and build the in-memory scheduler context - without starting
// execution. Shared by the synchronous runTaskPlan and the asynchronous
// startTaskPlan so both enforce identical plan validation and artifact layout.
async function prepareRun(plan, options = {}) {
  assertPlanShape(plan)

  const planDir = path.resolve(options.planDir || process.cwd())
  const workspace = path.resolve(planDir, String(options.workspace || plan.workspace || '.'))
  const outputDir = path.resolve(
    planDir,
    String(options.outputDir || plan.outputDir || path.join(workspace, '.subagent-runs')),
  )
  const concurrency = Number(options.concurrency || plan.concurrency || 1)
  const dryRun = Boolean(options.dryRun || plan.dryRun)

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer')
  }

  const runId = options.runId || createRunId()
  const runDir = path.join(outputDir, runId)
  const startedAt = new Date().toISOString()
  const schema = options.schema || await readJson(resultSchemaPath)
  const claudeExecutable = await resolveClaudeExecutable(
    options.claudeExecutable || process.env.CLAUDE_BIN || process.env.CLAUDE_CODE_COMMAND,
  )
  const claudeBaseArgs = options.claudeBaseArgs || firstNonEmptyArray(
    parseJsonArrayEnv('SUBAGENT_CLAUDE_BASE_ARGS'),
    parseJsonArrayEnv('CLAUDE_CODE_BASE_ARGS'),
  )
  const tasks = plan.tasks.map((task) => normalizeTask(task, plan.defaults || {}, workspace, planDir))
  validateDependencies(tasks)

  await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true })
  await writeJson(path.join(runDir, 'run-input.json'), {
    runId,
    runDir,
    outputDir,
    startedAt,
    workspace,
    concurrency,
    dryRun,
    taskCount: tasks.length,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      kind: task.kind,
      dependsOn: task.dependsOn,
      timeoutMs: task.timeoutMs,
    })),
  })
  await writeRunRegistryEntry(outputDir, {
    runId,
    runDir,
    outputDir,
    workspace,
    startedAt,
    status: 'active',
    taskCount: tasks.length,
  }).catch(() => {})

  const cancellation = {
    cancelled: false,
    // Carrying runDir/outputDir on the cancellation record lets collectRun
    // resolve a live run from runId alone, and lets cancelRun explain which
    // run it touched.
    runId,
    runDir,
    outputDir,
    startedAt,
    async: false,
  }

  const scheduler = {
    runId,
    runDir,
    workspace,
    outputDir,
    concurrency,
    dryRun,
    schema,
    claudeExecutable,
    claudeBaseArgs,
    env: options.env,
    startedAt,
    maxParallelObserved: 0,
    cancellation,
  }

  return { scheduler, tasks, outputDir }
}

// Drive a prepared run to completion and persist run-summary.json. Used by both
// runTaskPlan (awaited) and startTaskPlan (fire-and-forget background promise).
async function executeRun(scheduler, tasks) {
  const results = await runTasks(tasks, scheduler)
  const endedAt = new Date().toISOString()
  const summary = summarizeRun({ ...scheduler, endedAt }, tasks, results)
  attachOwnershipValidation(summary, tasks, results, scheduler.workspace)
  await writeJson(path.join(scheduler.runDir, 'run-summary.json'), summary)
  await markRunRegistryEntry(scheduler.outputDir, scheduler.runId, deriveRunStatus(summary), {
    runDir: scheduler.runDir,
    endedAt,
  }).catch(() => {})
  return summary
}

// Second-layer asynchronous entry point. Validates and prepares the plan
// (identical to runTaskPlan), writes run-input.json, kicks off execution in the
// background, and returns immediately with a controller-readable handle. The
// background promise never surfaces an unhandled rejection: on success it writes
// the normal run-summary.json; on failure it writes a readable failure summary
// so collectRun/loadRunStatus can explain what went wrong.
export async function startTaskPlan(plan, options = {}) {
  const { scheduler, tasks, outputDir } = await prepareRun(plan, options)
  scheduler.cancellation.async = true
  activeRuns.set(scheduler.runId, scheduler.cancellation)

  const background = executeRun(scheduler, tasks)
    .then((summary) => {
      scheduler.cancellation.summary = summary
      scheduler.cancellation.status = deriveRunStatus(summary)
    })
    .catch(async (error) => {
      scheduler.cancellation.error = error
      scheduler.cancellation.status = 'failed'
      try {
        scheduler.cancellation.summary = await writeFailureSummary(scheduler, tasks, error)
      } catch {
        // writeFailureSummary is best-effort; cancellation.error is already set
        // so collectRun/loadRunStatus can still explain the failure from the
        // per-task result.json files and run-input.json that exist on disk.
      }
    })
    .finally(() => {
      // Drop the active registration once terminal, but retain a compact
      // runId -> runDir handle so subagent_collect can still resolve a runId-only
      // request after the background run has already completed.
      retainRunHandle(scheduler.cancellation)
      activeRuns.delete(scheduler.runId)
    })
  // Belt-and-suspenders: the chain above swallows every rejection, but keep an
  // explicit catcher so a future edit can never leak an unhandled rejection
  // into the host process (e.g. the MCP server).
  background.catch(() => {})
  scheduler.cancellation.promise = background

  return {
    runId: scheduler.runId,
    runDir: scheduler.runDir,
    workspace: scheduler.workspace,
    outputDir,
    status: 'running',
    startedAt: scheduler.startedAt,
    totalTasks: tasks.length,
    concurrency: scheduler.concurrency,
    dryRun: scheduler.dryRun,
  }
}

// Collect the status of an async (or sync) run. Returns whether the run is done
// plus a readable summary. Resolution order for the target run:
//   1. explicit runDir
//   2. runId still active (resolved from the active-run map)
// Once run-summary.json exists the run is treated as done; otherwise a
// loadRunStatus-compatible progress/event view is returned for an in-progress run.
export async function collectRun(input = {}) {
  const runId = input.runId
  let runDir = input.runDir ? path.resolve(input.runDir) : null

  if (!runDir && runId) {
    const record = activeRuns.get(runId)
    if (record?.runDir) runDir = record.runDir
  }
  if (!runDir && runId) {
    const record = retainedRuns.get(runId)
    if (record?.runDir) runDir = record.runDir
  }
  if (!runDir && runId && input.outputDir) {
    runDir = await resolveRunDirFromRegistry(path.resolve(input.outputDir), runId).catch(() => null)
  }
  if (!runDir && runId && input.outputDir) {
    const candidateRunDir = path.join(path.resolve(input.outputDir), runId)
    try {
      await fs.access(candidateRunDir)
      runDir = candidateRunDir
    } catch {
      runDir = null
    }
  }
  if (!runDir && runId) {
    const defaultOutputDir = input.outputDir
      || path.join(path.resolve(input.workspace || process.cwd()), '.subagent-runs')
    const defaultRunDir = path.join(path.resolve(defaultOutputDir), runId)
    try {
      runDir = await resolveRunDirFromRegistry(path.resolve(defaultOutputDir), runId).catch(() => null)
      if (runDir) throw new Error('__resolved_from_registry__')
      await fs.access(defaultRunDir)
      runDir = defaultRunDir
    } catch (error) {
      if (error?.message === '__resolved_from_registry__') {
        // runDir already resolved from the persisted registry.
      } else {
      runDir = null
      }
    }
  }
  if (!runDir) {
    throw new Error('collectRun requires runDir, an active runId, or outputDir with runId')
  }

  const resolvedRunId = runId || path.basename(runDir)
  const summaryPath = path.join(runDir, 'run-summary.json')
  let summary = null
  try {
    summary = await readJson(summaryPath)
  } catch {
    summary = null
  }
  if (!summary) summary = await recoverSummaryFromTaskResults(runDir)

  if (summary) {
    const eventView = await buildRunEventView(summary, runDir, {
      recentEventsLimit: input.recentEventsLimit,
      staleHeartbeatMs: input.staleHeartbeatMs,
      slowEventMs: input.slowEventMs,
    })
    const payload = {
      done: true,
      runId: summary.runId || resolvedRunId,
      runDir,
      status: deriveRunStatus(summary),
      summary,
      runSummary: summary,
      results: Array.isArray(summary.tasks) ? summary.tasks : [],
      active: listActiveProcesses(summary.runId || resolvedRunId),
      recentEvents: eventView.recentEvents,
      taskEvents: eventView.taskEvents,
      health: eventView.health,
    }
    if (input.includeControllerSummary !== false) {
      payload.controllerSummary = buildControllerSummary(payload)
    }
    return payload
  }

  // Still running: surface the same progress/event state subagent_status uses.
  const progress = await loadRunStatus({
    runDir,
    recentEventsLimit: input.recentEventsLimit,
    staleHeartbeatMs: input.staleHeartbeatMs,
    slowEventMs: input.slowEventMs,
    includeControllerSummary: input.includeControllerSummary,
  })
  const payload = {
    done: false,
    runId: resolvedRunId,
    runDir,
    status: 'running',
    mode: progress.mode,
    summary: progress.summary,
    active: progress.active,
    recentEvents: progress.recentEvents,
    taskEvents: progress.taskEvents,
    health: progress.health,
    controllerSummary: progress.controllerSummary,
  }
  return payload
}

export async function watchRun(input = {}) {
  const collected = await collectRun(input)
  const health = collected.health || summarizeRunHealth(collected.taskEvents || [], collected.active || [])
  const suggestedAction = suggestControllerAction(collected, health)
  const payload = {
    ...collected,
    health,
    suggestedAction,
  }
  if (input.includeControllerSummary !== false) {
    payload.controllerSummary = collected.controllerSummary || buildControllerSummary(collected)
  }
  return input.compact || input.healthOnly
    ? compactWatchPayload(payload, input)
    : payload
}

export async function loadDesktopStatus(input = {}) {
  if (input.readMirror === true && !input.runId && !input.runDir && !input.outputDir) {
    const mirror = await readStatusMirror(input)
    const mirrorView = mirror?.snapshot || null
    return {
      source: 'mirror',
      mirror,
      mirrorDir: resolveStatusMirrorDir(input),
      view: mirrorView,
      schema: mirrorView?.schema || null,
      // The mirror snapshot is a previously redacted RunViewModel, so a present
      // view always means a redacted, display-safe payload.
      redacted: Boolean(mirrorView),
    }
  }

  const statusPayload = input.runId
    ? await collectRun({
      runId: input.runId,
      runDir: input.runDir,
      workspace: input.workspace,
      outputDir: input.outputDir,
      recentEventsLimit: input.recentEventsLimit,
      staleHeartbeatMs: input.staleHeartbeatMs,
      slowEventMs: input.slowEventMs,
      includeControllerSummary: false,
    })
    : await loadRunStatus({
      runDir: input.runDir,
      outputDir: input.outputDir,
      limit: input.limit,
      recentEventsLimit: input.recentEventsLimit,
      staleHeartbeatMs: input.staleHeartbeatMs,
      slowEventMs: input.slowEventMs,
      includeControllerSummary: false,
    })

  const view = buildRunViewModel(statusPayload, {
    staleMs: input.staleHeartbeatMs,
  })
  const result = {
    source: input.runId || input.runDir ? 'run' : 'list',
    view,
    mirrorDir: resolveStatusMirrorDir(input),
    // Surface the view-model schema tag and the fact that the view is always
    // redacted (buildRunViewModel never places raw prompts/stdout/env/full
    // command bodies; command/verification snippets pass through redactForDisplay).
    // This lets desktop consumers assert the contract without inspecting `view`.
    schema: view?.schema || null,
    redacted: Boolean(view),
  }

  if (input.includeRaw === true) {
    result.raw = statusPayload
  }
  if (input.writeMirror === true) {
    result.mirror = await writeStatusMirror({
      ...input,
      runId: view?.runId,
      snapshot: view,
    })
  } else if (input.readMirror === true) {
    result.mirror = await readStatusMirror(input)
  }

  return result
}

// Filter a bounded event list by incremental cursor parameters, without ever
// reading or streaming full event logs. Operates only on the already-bounded
// recent-events window produced by buildRunViewModel (newest last), so the
// result is always small. All parameters optional:
//   afterSequence - return only events whose `sequence` is a number > this
//   since         - ISO timestamp lower bound (inclusive); events with no
//                   parseable timestamp are dropped when this is set
//   limit         - cap the result to the most recent N events (tail)
// Tolerates missing/malformed fields: an event with no sequence is excluded by
// an afterSequence filter, and an event with no timestamp is excluded by a
// since filter, so a cursor never silently leaks unbounded data.
export function filterIncrementalEvents(events, options = {}) {
  if (!Array.isArray(events)) return []
  let filtered = events

  const afterSequence = options.afterSequence
  if (typeof afterSequence === 'number' && Number.isFinite(afterSequence)) {
    filtered = filtered.filter(
      (event) => typeof event?.sequence === 'number' && event.sequence > afterSequence,
    )
  }

  const since = options.since
  if (typeof since === 'string' && since.length) {
    const sinceMs = Date.parse(since)
    if (Number.isFinite(sinceMs)) {
      filtered = filtered.filter((event) => {
        const ts = event?.timestamp || event?.ts
        if (!ts) return false
        const ms = Date.parse(ts)
        return Number.isFinite(ms) && ms >= sinceMs
      })
    }
  }

  const limit = options.limit
  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
    // Events are newest-last, so the most recent N is the tail.
    filtered = filtered.slice(-Math.floor(limit))
  }
  return filtered
}

function retainRunHandle(record) {
  if (!record?.runId || !record?.runDir) return
  retainedRuns.set(record.runId, {
    runId: record.runId,
    runDir: record.runDir,
    outputDir: record.outputDir,
    status: record.status,
    endedAt: new Date().toISOString(),
  })
  while (retainedRuns.size > RETAINED_RUN_LIMIT) {
    const firstKey = retainedRuns.keys().next().value
    if (!firstKey) break
    retainedRuns.delete(firstKey)
  }
}

async function recoverSummaryFromTaskResults(runDir) {
  let input
  try {
    input = await readJson(path.join(runDir, 'run-input.json'))
  } catch {
    return null
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  if (!tasks.length) return null

  const results = []
  for (const task of tasks) {
    try {
      results.push(await readJson(path.join(runDir, 'tasks', task.id, 'result.json')))
    } catch {
      return null
    }
  }

  const endedAt = new Date().toISOString()
  const summary = summarizeRun(
    {
      runId: input.runId || path.basename(runDir),
      runDir,
      startedAt: input.startedAt,
      endedAt,
      workspace: input.workspace,
      concurrency: input.concurrency,
      maxParallelObserved: input.concurrency || 0,
      dryRun: input.dryRun,
    },
    tasks,
    results,
  )
  summary.recovered = true
  return summary
}

// Derive a single run-level status from a run summary. summarizeRun does not
// emit a top-level status, so infer it from the task tallies (and any explicit
// status/error written by the async failure path).
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

// Persist a readable failure summary when the async background run rejects
// (e.g. a dependency cycle surfaced mid-run, or runTasks threw). Gathers
// whatever per-task result.json files already made it to disk so the summary
// explains how far the run got; tasks that never started are marked cancelled
// (if the run was cancelled) or skipped.
async function writeFailureSummary(scheduler, tasks, error) {
  const endedAt = new Date().toISOString()
  const results = await collectPersistedTaskResults(scheduler.runDir, tasks, scheduler)
  const summary = summarizeRun({ ...scheduler, endedAt }, tasks, results)
  summary.status = 'failed'
  summary.error = error?.stack || String(error)
  summary.endedAt = endedAt
  attachOwnershipValidation(summary, tasks, results, scheduler.workspace)
  await writeJson(path.join(scheduler.runDir, 'run-summary.json'), summary)
  await markRunRegistryEntry(scheduler.outputDir, scheduler.runId, 'failed', {
    runDir: scheduler.runDir,
    endedAt,
  }).catch(() => {})
  return summary
}

async function collectPersistedTaskResults(runDir, tasks, scheduler) {
  const cancelled = Boolean(scheduler?.cancellation?.cancelled)
  const now = new Date().toISOString()
  const results = []
  for (const task of tasks) {
    const taskDir = path.join(runDir, 'tasks', task.id)
    try {
      results.push(await readJson(path.join(taskDir, 'result.json')))
    } catch {
      results.push({
        id: task.id,
        title: task.title,
        status: cancelled ? 'cancelled' : 'skipped',
        startedAt: now,
        endedAt: now,
        taskDir,
        reason: 'Run failed before this task produced a result',
      })
    }
  }
  return results
}

// Upper bound on how many recent events we surface in a single-run status
// payload. Keeps the response small enough for Codex to inspect without
// dumping entire event logs.
const DEFAULT_RECENT_EVENTS_LIMIT = 20

export async function loadRunStatus({ runDir, outputDir, limit = 20, recentEventsLimit, staleHeartbeatMs, slowEventMs, includeControllerSummary } = {}) {
  if (runDir) {
    const resolved = path.resolve(runDir)
    const summaryPath = path.join(resolved, 'run-summary.json')
    let summary
    try {
      summary = await readJson(summaryPath)
    } catch {
      // The run may still be in progress (no run-summary.json yet). Fall back to
      // run-input.json so callers can still see task dirs; event enrichment
      // degrades gracefully when files are absent.
      summary = await readRunInputFallback(resolved)
    }
    // Report only this run's active processes, not every run the server knows about.
    const runId = summary?.runId || path.basename(resolved)
    const eventView = await buildRunEventView(summary, resolved, {
      recentEventsLimit,
      staleHeartbeatMs,
      slowEventMs,
    })
    const payload = {
      mode: 'single',
      summary,
      active: listActiveProcesses(runId),
      recentEvents: eventView.recentEvents,
      taskEvents: eventView.taskEvents,
      health: eventView.health,
    }
    if (includeControllerSummary !== false) {
      payload.controllerSummary = buildControllerSummary(payload)
    }
    return payload
  }

  const baseDir = path.resolve(outputDir || path.join(process.cwd(), '.subagent-runs'))
  await recoverRunsFromOutputDir(baseDir).catch(() => null)
  let entries = []
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true })
  } catch {
    return { mode: 'list', outputDir: baseDir, runs: [], active: listActiveProcesses() }
  }

  const runDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name))
    .sort()
    .reverse()
    .slice(0, limit)

  const runs = []
  for (const dir of runDirs) {
    try {
      runs.push(await readJson(path.join(dir, 'run-summary.json')))
    } catch {
      runs.push({ runDir: dir, status: 'incomplete_or_unreadable' })
    }
  }

  // List mode stays compact: we do NOT open every task's events.jsonl. The only
  // event signal we surface is derived from data already present in each run
  // summary (task results may carry eventLogPath), so this is cheap.
  return {
    mode: 'list',
    outputDir: baseDir,
    runs,
    active: listActiveProcesses(),
    statusEvents: { runsWithEventLogs: countRunsWithEventLogs(runs) },
  }
}

// Read a task's events.jsonl safely. Tolerates a missing file (returns no
// events) and skips any malformed/unparseable lines instead of throwing.
async function readEventsFile(eventsPath) {
  let text
  try {
    text = await fs.readFile(eventsPath, 'utf8')
  } catch {
    return { exists: false, events: [] }
  }
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event)
    } catch {
      // Malformed line - skip it rather than failing the whole status read.
    }
  }
  return { exists: true, events }
}

// Build the list of task entries to inspect for events. Prefers the task
// results already in the run summary (which carry taskDir / eventLogPath); when
// no summary is available (run still in progress), scans runDir/tasks so we can
// still report live heartbeats/phases.
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

// Reduce a task's raw event list to a compact summary. Events are assumed
// append-ordered (chronological), so "latest" means last-seen in file order.
function summarizeTaskEvents(events, eventLogPath) {
  const summary = summarizeEventList(events, eventLogPath)
  return { ...summary, ...assessHeartbeat(summary) }
}

// Trim an event down to a small whitelist of fields so recentEvents doesn't
// echo large payloads back to the caller.
function trimEvent(event, sequence) {
  const trimmed = trimProtocolEvent(event)
  if (!trimmed) return trimmed
  if (typeof sequence === 'number' && Number.isFinite(sequence)) {
    trimmed.sequence = sequence
  }
  return trimmed
}

function eventTimestamp(event) {
  return event?.timestamp || event?.ts
}

function compareTimestamp(a, b) {
  if (a && b) return a < b ? -1 : a > b ? 1 : 0
  if (a) return -1
  if (b) return 1
  return 0
}

// Build the event-aware view for a single run: a per-task summary attached to
// each task result, a flat taskEvents list, and a small merged recentEvents
// window across all tasks. Reads each task's events.jsonl once.
async function buildRunEventView(summary, runDir, options = {}) {
  const requestedLimit = Number(options.recentEventsLimit) || DEFAULT_RECENT_EVENTS_LIMIT
  const recentLimit = Math.max(0, Math.min(1000, requestedLimit))
  const taskEntries = await collectTaskEntries(summary, runDir)
  const taskEvents = []
  const allEvents = []
  const tasksById = new Map()
  if (summary && Array.isArray(summary.tasks)) {
    for (const task of summary.tasks) {
      if (task?.id) tasksById.set(task.id, task)
    }
  }

  for (const entry of taskEntries) {
    const eventsPath = entry.eventLogPath || (entry.taskDir ? path.join(entry.taskDir, 'events.jsonl') : null)
    if (!eventsPath) continue
    const { events } = await readEventsFile(eventsPath)
    const taskSummaryBase = summarizeTaskEvents(events, eventsPath)
    const taskSummary = {
      ...taskSummaryBase,
      ...assessHeartbeat(taskSummaryBase, {
        staleHeartbeatMs: options.staleHeartbeatMs,
        slowEventMs: options.slowEventMs,
      }),
    }
    taskEvents.push({ taskId: entry.id, ...taskSummary })
    // Attach the same summary to the in-memory task result so callers reading
    // summary.tasks see last heartbeat/phase inline. run-summary.json on disk
    // is untouched.
    const taskResult = tasksById.get(entry.id)
    if (taskResult) {
      taskResult.events = taskSummary
      taskResult.eventLogPath = taskResult.eventLogPath || taskSummary.eventLogPath
      if (taskSummary.lastEventAt) taskResult.lastEventAt = taskSummary.lastEventAt
      if (taskSummary.lastHeartbeatAt) taskResult.lastHeartbeatAt = taskSummary.lastHeartbeatAt
    }
    for (const event of events) allEvents.push(event)
  }

  const sorted = allEvents
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const timestampOrder = compareTimestamp(eventTimestamp(a.event), eventTimestamp(b.event))
      if (timestampOrder !== 0) return timestampOrder
      const taskOrder = compareText(a.event?.taskId, b.event?.taskId)
      if (taskOrder !== 0) return taskOrder
      return a.index - b.index
    })
  const sequenced = sorted
    .map((entry, index) => trimEvent(entry.event, index + 1))
    .filter(Boolean)
  const recentEvents = sequenced.slice(-recentLimit)
  return { recentEvents, taskEvents, health: summarizeRunHealth(taskEvents) }
}

// When run-summary.json is missing (run in progress), reconstruct a minimal
// summary from run-input.json so event enrichment can still locate task dirs.
async function readRunInputFallback(runDir) {
  try {
    const input = await readJson(path.join(runDir, 'run-input.json'))
    return {
      runId: path.basename(runDir),
      runDir,
      tasks: (input.tasks || []).map((task) => ({
        id: task.id,
        taskDir: path.join(runDir, 'tasks', task.id),
      })),
    }
  } catch {
    return { runId: path.basename(runDir), runDir, tasks: [] }
  }
}

// Cheap list-mode signal: count runs whose task results already advertise an
// eventLogPath. Does not open any events.jsonl files.
function countRunsWithEventLogs(runs) {
  let count = 0
  for (const run of runs) {
    if (run && Array.isArray(run.tasks) && run.tasks.some((task) => task && task.eventLogPath)) count++
  }
  return count
}

function summarizeRunHealth(taskEvents = [], active = []) {
  const activeIds = new Set((active || []).map((record) => record?.taskId).filter(Boolean))
  const stalledTasks = []
  const slowTasks = []
  const blockedTasks = []
  let needsController = false
  let latestHeartbeatAt
  let latestEventAt

  for (const task of taskEvents || []) {
    if (!task) continue
    if (task.lastHeartbeatAt && (!latestHeartbeatAt || task.lastHeartbeatAt > latestHeartbeatAt)) {
      latestHeartbeatAt = task.lastHeartbeatAt
    }
    if (task.lastEventAt && (!latestEventAt || task.lastEventAt > latestEventAt)) {
      latestEventAt = task.lastEventAt
    }
    if (task.blockedReason) {
      blockedTasks.push({ taskId: task.taskId, reason: task.blockedReason })
      needsController = true
    }
    if (task.needsController) needsController = true
    if (activeIds.size && task.taskId && !activeIds.has(task.taskId)) continue
    if (task.stalled) {
      stalledTasks.push({ taskId: task.taskId, lastHeartbeatAt: task.lastHeartbeatAt, lastEventAt: task.lastEventAt })
      needsController = true
    }
    if (task.slow) {
      slowTasks.push({ taskId: task.taskId, lastEventAt: task.lastEventAt })
    }
  }

  return {
    status: needsController ? 'needs_controller' : stalledTasks.length ? 'stalled' : slowTasks.length ? 'slow' : 'ok',
    needsController,
    stalledTasks,
    slowTasks,
    blockedTasks,
    latestHeartbeatAt,
    latestEventAt,
  }
}

function suggestControllerAction(payload, health = {}) {
  if (payload.done) return 'collect_complete'
  if (health.needsController || health.stalledTasks?.length) return 'inspect_or_cancel_stalled_tasks'
  if (health.slowTasks?.length) return 'continue_monitoring'
  if (payload.active?.length) return 'continue_waiting'
  return 'inspect_run_state'
}

function compareText(a, b) {
  const left = typeof a === 'string' ? a : ''
  const right = typeof b === 'string' ? b : ''
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compactWatchPayload(payload, input = {}) {
  return {
    done: payload.done,
    runId: payload.runId,
    runDir: payload.runDir,
    status: payload.status,
    active: payload.active,
    health: payload.health,
    controllerSummary: input.includeControllerSummary === false ? undefined : payload.controllerSummary,
    suggestedAction: payload.suggestedAction,
    recentEvents: input.recentEventsLimit ? payload.recentEvents : undefined,
    taskEvents: input.includeTaskEvents ? payload.taskEvents : undefined,
  }
}

function attachOwnershipValidation(summary, tasks, results, workspace) {
  try {
    const ownership = validateRunFileOwnership({ tasks, results, workspace })
    if (ownership?.violations?.length) summary.ownershipViolations = ownership.violations
    if (ownership?.warnings?.length) summary.ownershipWarnings = ownership.warnings
  } catch (error) {
    summary.ownershipWarnings = [
      ...(summary.ownershipWarnings || []),
      { warning: 'ownership validation failed', detail: error?.message || String(error) },
    ]
  }
}

export async function cancelRun(runId) {
  // Signal the scheduler loop to stop starting pending tasks, then kill the
  // Claude processes that are already running for this run. Works for both
  // synchronous runTaskPlan runs and asynchronous startTaskPlan runs - both
  // register the same cancellation record under runId.
  const cancellation = activeRuns.get(runId)
  if (cancellation) cancellation.cancelled = true
  return cancelActiveRun(runId)
}

export function assertPlanShape(plan) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Invalid plan: expected { version: 1, tasks: [...] }')
  }
}

function normalizeTask(task, defaults, workspace, planDir) {
  if (!task.id || !/^[A-Za-z0-9._-]+$/.test(task.id)) {
    throw new Error(`Invalid task id: ${task.id}`)
  }
  if (!task.title || !task.prompt) {
    throw new Error(`Task ${task.id} must include title and prompt`)
  }

  const merged = { ...defaults, ...task }
  const addDirs = unique([workspace, ...(defaults.addDirs || []), ...(task.addDirs || [])])
    .map((dir) => path.resolve(planDir, dir))

  // `timeoutMs` is an idle timeout, not an absolute wall-clock deadline. The
  // runner resets the idle window when it observes a subagent-owned event or
  // heartbeat in SCP_EVENT_LOG; runtime-owned heartbeats do not reset it.
  const timeoutMs = Number(merged.timeoutMs || 600000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`Task ${task.id} has invalid timeoutMs: ${merged.timeoutMs} (must be an integer >= 1000)`)
  }

  // Read-only safety for review/verify work: when the caller has not customized
  // tool restrictions, block the mutating file-edit tools so a review can't
  // rewrite the repo it is inspecting. Explicit allowedTools/disallowedTools opt out.
  const readOnlyKind = task.kind === 'review' || task.kind === 'verify'
  const callerRestrictedTools = Boolean(
    (task.allowedTools && task.allowedTools.length) || (task.disallowedTools && task.disallowedTools.length),
  )
  const disallowedTools = [...(merged.disallowedTools || [])]
  if (readOnlyKind && !callerRestrictedTools) {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      if (!disallowedTools.includes(tool)) disallowedTools.push(tool)
    }
  }

  return {
    id: task.id,
    title: task.title,
    kind: task.kind || 'other',
    prompt: task.prompt,
    dependsOn: task.dependsOn || [],
    model: merged.model,
    effort: merged.effort,
    timeoutMs,
    permissionMode: merged.permissionMode || 'default',
    addDirs,
    allowedTools: merged.allowedTools || [],
    disallowedTools,
    tools: merged.tools,
    systemPrompt: merged.systemPrompt || '',
    workspace,
  }
}

function validateDependencies(tasks) {
  const ids = new Set()
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`)
    }
    ids.add(task.id)
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Task ${task.id} depends on missing task ${dep}`)
      }
    }
  }
}

async function runTasks(tasks, scheduler) {
  const pending = new Map(tasks.map((task) => [task.id, task]))
  const running = new Map()
  const finished = new Map()
  const results = []

  while (pending.size || running.size) {
    // If the run was cancelled, stop starting new tasks: mark everything still
    // pending as cancelled and let the already-running (and being-killed) tasks
    // drain through the normal completion path below.
    if (scheduler.cancellation.cancelled && pending.size) {
      for (const [taskId, task] of pending) {
        const cancelled = await writeCancelledTask(task, scheduler)
        finished.set(taskId, cancelled)
        results.push(cancelled)
      }
      pending.clear()
    }

    let startedAny = false

    for (const [taskId, task] of pending) {
      if (running.size >= scheduler.concurrency) break

      const depResults = task.dependsOn.map((depId) => finished.get(depId)).filter(Boolean)
      if (depResults.length !== task.dependsOn.length) continue

      const failedDep = depResults.find((result) => !['completed', 'partial'].includes(result.status))
      if (failedDep) {
        const skipped = await writeSkippedTask(task, scheduler, failedDep)
        pending.delete(taskId)
        finished.set(taskId, skipped)
        results.push(skipped)
        startedAny = true
        continue
      }

      pending.delete(taskId)
      const promise = runClaudeTask(task, scheduler).catch((error) => writeFailedTask(task, scheduler, error))
      running.set(taskId, promise)
      scheduler.maxParallelObserved = Math.max(scheduler.maxParallelObserved, running.size)
      startedAny = true
    }

    if (!running.size) {
      if (!startedAny && pending.size) {
        throw new Error('No runnable tasks remain; check dependency cycles')
      }
      continue
    }

    const completed = await Promise.race(
      [...running.entries()].map(([taskId, promise]) =>
        promise.then((result) => ({ taskId, result })),
      ),
    )
    running.delete(completed.taskId)
    finished.set(completed.taskId, completed.result)
    results.push(completed.result)
  }

  return results.sort((a, b) => tasks.findIndex((task) => task.id === a.id) - tasks.findIndex((task) => task.id === b.id))
}

async function writeSkippedTask(task, scheduler, failedDep) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  const now = new Date().toISOString()
  const result = {
    id: task.id,
    title: task.title,
    status: 'skipped',
    startedAt: now,
    endedAt: now,
    taskDir,
    reason: `Dependency ${failedDep.id} ended with status ${failedDep.status}`,
  }
  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

async function writeCancelledTask(task, scheduler) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  const now = new Date().toISOString()
  const result = {
    id: task.id,
    title: task.title,
    status: 'cancelled',
    startedAt: now,
    endedAt: now,
    taskDir,
    reason: 'Run cancelled before this task started',
  }
  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

async function writeFailedTask(task, scheduler, error) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  const now = new Date().toISOString()
  const result = {
    id: task.id,
    title: task.title,
    status: 'failed',
    startedAt: now,
    endedAt: now,
    taskDir,
    error: error?.stack || String(error),
  }
  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

function summarizeRun(scheduler, tasks, results) {
  return {
    runId: scheduler.runId,
    runDir: scheduler.runDir,
    startedAt: scheduler.startedAt,
    endedAt: scheduler.endedAt,
    workspace: scheduler.workspace,
    concurrency: scheduler.concurrency,
    maxParallelObserved: scheduler.maxParallelObserved,
    dryRun: scheduler.dryRun,
    totalTasks: tasks.length,
    completedTasks: results.filter((result) => result.status === 'completed').length,
    partialTasks: results.filter((result) => result.status === 'partial').length,
    blockedTasks: results.filter((result) => result.status === 'blocked').length,
    failedTasks: results.filter((result) => result.status === 'failed').length,
    skippedTasks: results.filter((result) => result.status === 'skipped').length,
    cancelledTasks: results.filter((result) => result.status === 'cancelled').length,
    timedOutTasks: results.filter((result) => result.status === 'timed_out').length,
    tasks: results,
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function parseJsonArrayEnv(name) {
  const raw = process.env[name]
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function firstNonEmptyArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length > 0) || []
}

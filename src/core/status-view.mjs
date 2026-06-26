// Desktop-facing status view model for SCP.
//
// The SCP runtime produces a handful of heterogeneous shapes: run-summary.json,
// subagent_collect / subagent_status payloads, in-memory run handles, and raw
// JSONL event records. A desktop client (status bar, tray app, dashboard) wants
// one stable, predictable snapshot it can render without re-implementing the
// unwrap/normalize dance every time. buildRunViewModel() reduces any of those
// inputs to a compact RunViewModel; buildTaskViewModel() and
// buildEventViewModel() do the same for a single task result and a single event
// record. summarizeTokenEvidence() pulls whatever measured token/cost evidence
// is present into a stable, non-fabricating shape.
//
// These functions are pure: given the same input they return the same output,
// they never touch the filesystem, and they never throw when fields are missing
// - a missing or malformed input yields a minimal, well-formed view model with
// nulls in the gaps rather than an exception. That lets a UI render partial
// state (an in-progress run, a task with no result yet) without try/catching
// every field access.
//
// No external dependencies. Node builtins only.

const DEFAULT_STALE_MS = 120_000
const SNIPPET_LIMIT = 200
const MAX_RISKS = 8
const MAX_NEXT_ACTIONS = 10
const OBSERVABILITY_VALUES = new Set(['live', 'summary-only'])

// Event types that indicate real forward progress for a human watching a run.
// Used to pick `lastUsefulEventAt` — the most recent timestamp a viewer would
// care about — rather than the raw tail which may include noise.
const USEFUL_EVENT_TYPES = new Set([
  'run_started', 'run_finished',
  'phase_started', 'phase_finished',
  'task_started', 'task_finished', 'task_result',
  'command_started', 'command_finished',
  'checkpoint', 'heartbeat', 'blocked', 'unblocked',
])

// Public entry point: reduce any run-shaped input to a RunViewModel snapshot.
// `options.now` (a () => number or ISO string) and `options.staleMs` are
// injectable for deterministic testing.
export function buildRunViewModel(input, options = {}) {
  const now = resolveNow(options.now)
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS
  const { summary, runtime, mode } = unwrap(input)

  if (mode === 'status-list') {
    return buildListViewModel(runtime, { now, staleMs })
  }

  const tasks = collectTasks(summary, runtime)
  const counts = countTasks(summary, tasks)
  const status = resolveStatus(summary, runtime, counts)
  const phase = runtime.done === false ? 'in_progress' : 'final'

  const taskViewModels = tasks.map((task) => buildTaskViewModel(task))
  const recentEvents = collectRecentEvents(runtime, summary)
  const tokenEvidence = summarizeTokenEvidence({ summary, tasks })
  const health = buildHealth(summary, runtime, counts, { now, staleMs })
  const activeTasks = collectActive(runtime, tasks)
  const lastEvent = lastUsefulEvent(recentEvents)
  const running = status === 'running' || phase === 'in_progress'
  const display = buildDisplayFields({
    status, health, counts, phase, activeTaskCount: activeTasks.length,
    lastEvent, now, staleMs, running,
  })

  const out = {
    schema: 'scp.run-view/v1',
    mode: 'run',
    runId: summary?.runId || runtime.runId || null,
    runDir: summary?.runDir || runtime.runDir || null,
    status,
    phase,
    displayStatus: display.displayStatus,
    statusTone: display.statusTone,
    progressHint: display.progressHint,
    activeTaskCount: display.activeTaskCount,
    lastUsefulEventAt: display.lastUsefulEventAt,
    stalenessMs: display.stalenessMs,
    staleThresholdMs: staleMs,
    counts,
    tasks: taskViewModels,
    activeTasks,
    recentEvents,
    tokenEvidence,
    health,
    artifacts: buildArtifacts(summary, tasks),
  }

  if (summary?.recovered) out.recovered = true
  if (summary?.error) out.error = snippet(String(summary.error), SNIPPET_LIMIT)
  if (summary?.dryRun) out.dryRun = true
  if (summary?.startedAt) out.startedAt = summary.startedAt
  if (summary?.endedAt) out.endedAt = summary.endedAt

  return pruneUndefined(out)
}

// Reduce a single task-result object to a TaskViewModel. Tolerates a missing or
// malformed task and never throws. `input` may be the raw task result or a
// wrapper that carries it under `task` / `result`.
export function buildTaskViewModel(input) {
  const task = unwrapTask(input)
  if (!task) {
    return { schema: 'scp.task-view/v1', taskId: null, status: 'unknown' }
  }

  const parsed = task.parsed || {}
  const files = Array.isArray(parsed.filesChanged) ? parsed.filesChanged : []
  const risks = Array.isArray(parsed.risks) ? parsed.risks : []
  const verification = Array.isArray(parsed.verification) ? parsed.verification : []
  const commands = Array.isArray(parsed.commandsRun) ? parsed.commandsRun : []

  const out = {
    schema: 'scp.task-view/v1',
    taskId: task.id || null,
    title: task.title || parsed.title || null,
    status: normalizeTaskStatus(task.status),
    kind: task.kind || parsed.kind || null,
    taskDir: task.taskDir || null,
    resultPath: task.taskDir ? joinPosix(task.taskDir, 'result.json') : (task.resultPath || null),
    eventLogPath: task.eventLogPath || (task.taskDir ? joinPosix(task.taskDir, 'events.jsonl') : null),
    startedAt: task.startedAt || null,
    endedAt: task.endedAt || null,
    durationMs: typeof task.durationMs === 'number' && Number.isFinite(task.durationMs) ? task.durationMs : undefined,
    filesChanged: files.map(normalizeFileChange).filter(Boolean),
    risks: risks.slice(0, MAX_RISKS).map(normalizeRisk).filter(Boolean),
    verification: verification.map(normalizeVerification).filter(Boolean),
    commandsRun: commands.map(normalizeCommand).filter(Boolean),
    nextSteps: collectNextSteps(parsed.nextSteps),
    tokenEvidence: summarizeTokenEvidence(task),
    blocked: task.blocked || parsed.blocked || undefined,
    error: task.error || parsed.error ? snippet(String(task.error || parsed.error), SNIPPET_LIMIT) : undefined,
    runtime: firstString(task.runtime, parsed.workerRuntime, parsed.runtime),
    dispatcher: firstString(task.dispatcher, parsed.dispatcher),
    workerType: firstString(task.workerType, parsed.workerType),
    workerAlias: firstString(task.workerAlias, parsed.workerAlias),
    fallbackApplied: firstBoolean(task.fallbackApplied, parsed.fallbackApplied),
    observability: resolveObservability(task, parsed),
  }

  return pruneUndefined(out)
}

// Reduce a single JSONL event record to an EventViewModel. Tolerates a missing
// or malformed event and never throws. Keeps only the small, render-relevant
// subset so a desktop list view stays cheap.
export function buildEventViewModel(input) {
  const event = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const ts = event.timestamp || event.ts || null
  const out = {
    schema: 'scp.event-view/v1',
    type: event.type || null,
    timestamp: ts,
    runId: event.runId || null,
    taskId: event.taskId || null,
    phase: event.phase || null,
    label: event.label || null,
    summary: event.summary ? snippet(String(event.summary), SNIPPET_LIMIT) : null,
    message: event.message ? snippet(String(event.message), SNIPPET_LIMIT) : null,
    reason: event.reason ? snippet(String(event.reason), SNIPPET_LIMIT) : null,
    status: event.status || null,
    exitCode: typeof event.exitCode === 'number' ? event.exitCode : null,
    sequence: typeof event.sequence === 'number' ? event.sequence : null,
    durationMs: typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) ? event.durationMs : undefined,
  }
  return pruneUndefined(out)
}

// Pull measured token/cost evidence from a task or run into a stable shape.
// Never fabricates: when no measured numbers are present, `measured` is false
// and `totals` is omitted. Accepts a task result, a run-summary object, or an
// explicit { summary, tasks } wrapper.
export function summarizeTokenEvidence(input) {
  if (!input || typeof input !== 'object') {
    return { schema: 'scp.token-evidence/v1', measured: false }
  }

  // Explicit wrapper { summary, tasks } from buildRunViewModel.
  const tasks = Array.isArray(input.tasks)
    ? input.tasks
    : input.parsed || input.usage || input.metrics
      ? [input]
      : []

  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheCreate = 0
  let costUsd = 0
  let measured = false

  // A run-summary may carry aggregated totals directly.
  const summaryTotals = input.tokenUsage || input.totals || input.tokenCost || (input.summary && input.summary.tokenUsage)
  if (summaryTotals && typeof summaryTotals === 'object') {
    const sIn = pickNum(summaryTotals, ['input', 'inputTokens', 'input_tokens'])
    const sOut = pickNum(summaryTotals, ['output', 'outputTokens', 'output_tokens'])
    const sCr = pickNum(summaryTotals, ['cacheRead', 'cache_read_input_tokens', 'cacheReadInputTokens'])
    const sCc = pickNum(summaryTotals, ['cacheCreate', 'cache_creation_input_tokens', 'cacheCreationInputTokens'])
    const sCost = pickNum(summaryTotals, ['costUsd', 'cost_usd', 'cost'])
    if (sIn != null) { inputTokens += sIn; measured = true }
    if (sOut != null) { outputTokens += sOut; measured = true }
    if (sCr != null) { cacheRead += sCr; measured = true }
    if (sCc != null) { cacheCreate += sCc; measured = true }
    if (sCost != null) { costUsd += sCost; measured = true }
  }

  for (const task of tasks) {
    const usage = task.usage
    if (usage && typeof usage === 'object') {
      const inT = pickNum(usage, ['input_tokens', 'inputTokens', 'tokensInput'])
      const outT = pickNum(usage, ['output_tokens', 'outputTokens', 'tokensOutput'])
      const cr = pickNum(usage, ['cache_read_input_tokens', 'cacheReadInputTokens'])
      const cc = pickNum(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens'])
      const c = pickNum(usage, ['cost_usd', 'costUsd'])
        ?? pickNum(task, ['costUsd'])
        ?? pickNum(task?.parsed?.metrics, ['costUsd', 'cost_usd'])
      if (inT != null) { inputTokens += inT; measured = true }
      if (outT != null) { outputTokens += outT; measured = true }
      if (cr != null) { cacheRead += cr; measured = true }
      if (cc != null) { cacheCreate += cc; measured = true }
      if (c != null) { costUsd += c; measured = true }
    }
  }

  const total = measured && (inputTokens || outputTokens || cacheRead || cacheCreate)
    ? inputTokens + outputTokens + cacheRead + cacheCreate
    : undefined

  return pruneUndefined({
    schema: 'scp.token-evidence/v1',
    measured,
    totals: pruneUndefined({
      input: measured && inputTokens ? inputTokens : undefined,
      output: measured && outputTokens ? outputTokens : undefined,
      cacheRead: measured && cacheRead ? cacheRead : undefined,
      cacheCreate: measured && cacheCreate ? cacheCreate : undefined,
      total,
      costUsd: measured && costUsd ? Number(costUsd.toFixed(6)) : undefined,
    }),
    note: measured
      ? 'Aggregated measured usage from CLI envelopes; never self-reported estimates.'
      : 'No measured usage available; subagent self-report not trusted.',
  })
}

// ---------------------------------------------------------------------------
// Payload normalization (shared with controller-summary, kept private here so
// this module stays standalone and import-free).
// ---------------------------------------------------------------------------

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') {
    return { summary: null, runtime: {}, mode: 'unknown' }
  }

  if (payload.mode === 'list') {
    return {
      summary: null,
      runtime: {
        mode: 'list',
        outputDir: payload.outputDir,
        runs: Array.isArray(payload.runs) ? payload.runs : [],
        active: payload.active,
        statusEvents: payload.statusEvents,
      },
      mode: 'status-list',
    }
  }

  if (payload.mode === 'single' || Object.prototype.hasOwnProperty.call(payload, 'done')) {
    return {
      summary: payload.summary || payload.runSummary || null,
      runtime: {
        done: payload.done,
        status: payload.status,
        mode: payload.mode,
        runId: payload.runId,
        runDir: payload.runDir,
        active: payload.active,
        recentEvents: payload.recentEvents,
        taskEvents: payload.taskEvents,
        results: payload.results,
      },
      mode: payload.mode === 'single' ? 'status-single' : 'collect',
    }
  }

  if (payload.totalTasks !== undefined || Array.isArray(payload.tasks) || payload.runId) {
    return { summary: payload, runtime: {}, mode: 'run-summary' }
  }

  return { summary: payload, runtime: {}, mode: 'unknown' }
}

function unwrapTask(input) {
  if (!input || typeof input !== 'object') return null
  if (input.parsed || input.usage || input.id || input.taskDir) return input
  if (input.task && typeof input.task === 'object') return input.task
  if (input.result && typeof input.result === 'object') return input.result
  return input
}

function collectTasks(summary, runtime) {
  const fromSummary = summary && Array.isArray(summary.tasks) ? summary.tasks : []
  const fromResults = !fromSummary.length && Array.isArray(runtime.results) ? runtime.results : []
  const candidates = fromSummary.length ? fromSummary : fromResults
  return candidates.filter((task) => task && typeof task === 'object' && (task.id || task.taskDir))
}

// ---------------------------------------------------------------------------
// Counts / status / health
// ---------------------------------------------------------------------------

function countTasks(summary, tasks) {
  const empty = {
    total: 0,
    completed: 0,
    partial: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    timedOut: 0,
    running: 0,
    pending: 0,
  }
  if (summary && typeof summary.totalTasks === 'number') {
    return {
      total: summary.totalTasks,
      completed: num(summary.completedTasks),
      partial: num(summary.partialTasks),
      blocked: num(summary.blockedTasks),
      failed: num(summary.failedTasks),
      skipped: num(summary.skippedTasks),
      cancelled: num(summary.cancelledTasks),
      timedOut: num(summary.timedOutTasks),
      running: num(summary.runningTasks),
      pending: num(summary.pendingTasks),
    }
  }
  for (const task of tasks) {
    empty[statusKey(task.status)] += 1
    empty.total += 1
  }
  return empty
}

function resolveStatus(summary, runtime, counts) {
  if (runtime && typeof runtime.status === 'string' && runtime.status !== 'running') {
    return normalizeRunStatus(runtime.status)
  }
  if (runtime?.done === false) return 'running'
  if (summary && typeof summary.status === 'string') return normalizeRunStatus(summary.status)
  if (summary?.error) return 'failed'
  if (counts.running > 0 || counts.pending > 0) return 'running'
  if (counts.cancelled > 0) return 'cancelled'
  if (counts.failed > 0 || counts.timedOut > 0) return 'failed'
  if (counts.blocked > 0) return 'blocked'
  if (counts.total > 0 && counts.completed + counts.partial >= counts.total) return 'completed'
  if (counts.total > 0) return 'partial'
  return 'unknown'
}

// A coarse, render-friendly health signal derived from counts and runtime
// state. `ok` runs are complete with no failures; `running` is in progress and
// healthy; `warning` has blocked/stale tasks but no failures; `error` has
// failures/timeouts. `unknown` when there is nothing to say yet.
function buildHealth(summary, runtime, counts, { now, staleMs }) {
  const failed = counts.failed + counts.timedOut
  const running = runtime?.done === false
    || counts.running > 0
    || counts.pending > 0
    || (summary && !summary.endedAt && counts.total > 0 && counts.completed + counts.partial < counts.total)
  const active = Array.isArray(runtime?.active) ? runtime.active : []
  const staleCount = countStale(collectActive(runtime, collectTasks(summary, runtime)), runtime?.taskEvents, { now, staleMs })

  let level
  if (failed > 0) level = 'error'
  else if (counts.blocked > 0 || staleCount > 0) level = 'warning'
  else if (running) level = 'running'
  else if (counts.total > 0 && counts.completed + counts.partial >= counts.total) level = 'ok'
  else level = 'unknown'

  return pruneUndefined({
    level,
    running: Boolean(running) || undefined,
    activeCount: active.length || undefined,
    staleCount: staleCount || undefined,
    failedCount: failed || undefined,
    blockedCount: counts.blocked || undefined,
  })
}

function countStale(active, taskEvents, { now, staleMs }) {
  if (!Array.isArray(active) || !active.length) return 0
  const eventMap = new Map()
  if (Array.isArray(taskEvents)) {
    for (const entry of taskEvents) {
      if (entry && entry.taskId) eventMap.set(entry.taskId, entry)
    }
  }
  let stale = 0
  for (const record of active) {
    if (!record || !record.taskId) continue
    if (record.observability !== 'live') continue
    const events = eventMap.get(record.taskId) || {}
    const reference = events.lastHeartbeatAt || events.lastEventAt || record.lastHeartbeatAt || record.lastEventAt
    if (!reference) { stale += 1; continue }
    const ageMs = now() - Date.parse(reference)
    if (Number.isFinite(ageMs) && ageMs > staleMs) stale += 1
  }
  return stale
}

// ---------------------------------------------------------------------------
// Active tasks + recent events
// ---------------------------------------------------------------------------

function collectActive(runtime, tasks = []) {
  if (!Array.isArray(runtime?.active)) return []
  const metadata = new Map()
  for (const task of tasks) {
    if (task?.id) metadata.set(task.id, task)
  }
  return runtime.active
    .filter((record) => record && record.taskId)
    .map((record) => pruneUndefined({
      taskId: record.taskId,
      title: record.title || undefined,
      pid: record.pid ?? undefined,
      startedAt: record.startedAt || undefined,
      lastEventAt: record.lastEventAt || undefined,
      lastHeartbeatAt: record.lastHeartbeatAt || undefined,
      phase: record.phase || undefined,
      eventLogPath: record.eventLogPath || undefined,
      runtime: firstString(record.runtime, metadata.get(record.taskId)?.runtime, metadata.get(record.taskId)?.parsed?.workerRuntime, metadata.get(record.taskId)?.parsed?.runtime),
      dispatcher: firstString(record.dispatcher, metadata.get(record.taskId)?.dispatcher, metadata.get(record.taskId)?.parsed?.dispatcher),
      workerType: firstString(record.workerType, metadata.get(record.taskId)?.workerType, metadata.get(record.taskId)?.parsed?.workerType),
      workerAlias: firstString(record.workerAlias, metadata.get(record.taskId)?.workerAlias, metadata.get(record.taskId)?.parsed?.workerAlias),
      fallbackApplied: firstBoolean(record.fallbackApplied, metadata.get(record.taskId)?.fallbackApplied, metadata.get(record.taskId)?.parsed?.fallbackApplied),
      observability: resolveObservability(record, metadata.get(record.taskId)?.parsed || metadata.get(record.taskId)),
    }))
    .sort(compareActiveTaskView)
}

function collectRecentEvents(runtime, summary) {
  let events = []
  if (Array.isArray(runtime?.recentEvents)) events = runtime.recentEvents
  if (!events.length && summary && Array.isArray(summary.recentEvents)) events = summary.recentEvents
  if (!events.length) return []
  return events.map(buildEventViewModel)
}

// ---------------------------------------------------------------------------
// Display-oriented fields (UI-friendly summaries on top of the raw status)
// ---------------------------------------------------------------------------

// Pick the most recent "useful" event from the recent-events window. Falls back
// to the most recent event of any type when none of the useful types are
// present, so a viewer always gets a last-activity timestamp when events exist.
// Returns { ts, ms } (ts is the original timestamp string, ms the parsed epoch)
// or null when there is nothing usable.
function lastUsefulEvent(recentEvents) {
  if (!Array.isArray(recentEvents) || !recentEvents.length) return null
  let usefulPick = null
  let usefulMs = -Infinity
  let anyPick = null
  let anyMs = -Infinity
  for (const ev of recentEvents) {
    if (!ev || typeof ev !== 'object') continue
    const ts = ev.timestamp || ev.ts
    if (!ts) continue
    const ms = Date.parse(ts)
    if (!Number.isFinite(ms)) continue
    if (ms > anyMs) { anyMs = ms; anyPick = { ts, ms } }
    if (USEFUL_EVENT_TYPES.has(ev.type) && ms > usefulMs) { usefulMs = ms; usefulPick = { ts, ms } }
  }
  return usefulPick || anyPick
}

// Build the UI-friendly display fields for a single-run view model. All fields
// degrade to safe defaults (null / 0 / neutral) when source data is missing.
function buildDisplayFields({ status, health, counts, phase, activeTaskCount, lastEvent, now, staleMs, running }) {
  const stale = isStale(health, lastEvent, now, staleMs, running)
  return pruneUndefined({
    displayStatus: mapDisplayStatus(status, phase, stale),
    statusTone: mapStatusTone(status, health, stale),
    progressHint: buildProgressHint(counts, status, activeTaskCount),
    activeTaskCount: activeTaskCount || 0,
    lastUsefulEventAt: lastEvent ? lastEvent.ts : null,
    stalenessMs: computeStalenessMs(lastEvent, now),
  })
}

function isStale(health, lastEvent, now, staleMs, running) {
  if (health?.staleCount > 0) return true
  if (!running || !lastEvent) return false
  const age = now() - lastEvent.ms
  return Number.isFinite(age) && age > staleMs
}

function mapDisplayStatus(status, phase, stale) {
  if (stale && (status === 'running' || phase === 'in_progress')) return 'Stale'
  switch (status) {
    case 'running': return 'Running'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'blocked': return 'Blocked'
    case 'cancelled': return 'Cancelled'
    case 'partial': return 'Partial'
    case 'skipped': return 'Skipped'
    case 'list': return 'List'
    default: return 'Idle'
  }
}

function mapStatusTone(status, health, stale) {
  const level = health?.level
  if (level === 'error' || status === 'failed') return 'negative'
  if (stale || level === 'warning' || status === 'blocked') return 'warning'
  if (status === 'running' || level === 'running') return 'active'
  if (status === 'completed' || level === 'ok') return 'positive'
  return 'neutral'
}

function buildProgressHint(counts, status, activeTaskCount) {
  const total = counts?.total || 0
  const done = (counts?.completed || 0) + (counts?.partial || 0)
  const failed = (counts?.failed || 0) + (counts?.timedOut || 0)
  if (total > 0) {
    const parts = [`${done}/${total} tasks`]
    if (failed > 0) parts.push(`${failed} failed`)
    if (status === 'running' && activeTaskCount > 0) parts.push(`${activeTaskCount} active`)
    return parts.join(', ')
  }
  if (status === 'running') return activeTaskCount > 0 ? `${activeTaskCount} active` : 'Running'
  return null
}

function computeStalenessMs(lastEvent, now) {
  if (!lastEvent) return null
  const age = now() - lastEvent.ms
  return Number.isFinite(age) && age >= 0 ? Math.round(age) : null
}

// For list mode there is no recent-events window; approximate staleness from
// the active-process heartbeats. Returns the largest heartbeat age in ms, or
// null when no active task carries a usable timestamp.
function computeListStaleness(activeTasks, now) {
  if (!Array.isArray(activeTasks) || !activeTasks.length) return null
  let maxAge = null
  for (const task of activeTasks) {
    const ref = task?.lastHeartbeatAt || task?.lastEventAt || task?.startedAt
    if (!ref) continue
    const ms = Date.parse(ref)
    if (!Number.isFinite(ms)) continue
    const age = now() - ms
    if (Number.isFinite(age) && age >= 0 && (maxAge === null || age > maxAge)) maxAge = age
  }
  return maxAge === null ? null : Math.round(maxAge)
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function buildArtifacts(summary, tasks) {
  const runDir = summary?.runDir || null
  const taskArtifacts = tasks.map((task) => pruneUndefined({
    taskId: task.id || undefined,
    taskDir: task.taskDir || undefined,
    resultPath: task.taskDir ? joinPosix(task.taskDir, 'result.json') : (task.resultPath || undefined),
    eventLogPath: task.eventLogPath || (task.taskDir ? joinPosix(task.taskDir, 'events.jsonl') : undefined),
  }))
  return pruneUndefined({
    runDir,
    runSummaryPath: runDir ? joinPosix(runDir, 'run-summary.json') : undefined,
    runInputPath: runDir ? joinPosix(runDir, 'run-input.json') : undefined,
    tasks: taskArtifacts,
  })
}

// ---------------------------------------------------------------------------
// List-mode view model (subagent_status with mode: 'list')
// ---------------------------------------------------------------------------

function buildListViewModel(runtime, { now, staleMs }) {
  const runs = (runtime.runs || []).map((run) => {
    if (!run || typeof run !== 'object') return null
    if (run.status === 'incomplete_or_unreadable') {
      return { runDir: run.runDir || null, status: 'unknown', sourceStatus: 'incomplete_or_unreadable' }
    }
    return pruneUndefined({
      runId: run.runId || (run.runDir ? basename(run.runDir) : undefined),
      runDir: run.runDir || undefined,
      status: deriveRunStatusLite(run),
      startedAt: run.startedAt || undefined,
      endedAt: run.endedAt || undefined,
      totalTasks: run.totalTasks ?? undefined,
      completedTasks: run.completedTasks ?? undefined,
      failedTasks: run.failedTasks ?? undefined,
      blockedTasks: run.blockedTasks ?? undefined,
    })
  }).filter(Boolean)

  const activeTasks = collectActive(runtime)
  const activeTaskCount = activeTasks.length
  const staleCount = countStale(activeTasks, [], { now, staleMs })
  const stalenessMs = computeListStaleness(activeTasks, now)
  const health = buildListHealth(activeTaskCount, staleCount, runs.length)

  return pruneUndefined({
    schema: 'scp.run-view/v1',
    mode: 'list',
    status: 'list',
    phase: 'list',
    displayStatus: 'List',
    statusTone: staleCount > 0 ? 'warning' : activeTaskCount > 0 ? 'active' : 'neutral',
    progressHint: `${runs.length} run${runs.length === 1 ? '' : 's'}${activeTaskCount ? `, ${activeTaskCount} active` : ''}`,
    activeTaskCount,
    lastUsefulEventAt: null,
    stalenessMs,
    staleThresholdMs: staleMs,
    outputDir: runtime.outputDir || null,
    runs,
    activeTasks,
    health,
    counts: { total: runs.length },
  })
}

function deriveRunStatusLite(run) {
  if (typeof run.status === 'string') return normalizeRunStatus(run.status)
  if (run.error) return 'failed'
  if (num(run.failedTasks) || num(run.timedOutTasks)) return 'failed'
  if (num(run.blockedTasks)) return 'blocked'
  if (num(run.cancelledTasks)) return 'cancelled'
  const total = num(run.totalTasks)
  if (total > 0 && num(run.completedTasks) + num(run.partialTasks) >= total) return 'completed'
  if (total > 0) return 'running'
  return 'unknown'
}

function buildListHealth(activeTaskCount, staleCount, runCount) {
  let level = 'unknown'
  if (staleCount > 0) level = 'warning'
  else if (activeTaskCount > 0) level = 'running'
  else if (runCount > 0) level = 'ok'

  return pruneUndefined({
    level,
    running: activeTaskCount > 0 || undefined,
    activeCount: activeTaskCount || undefined,
    staleCount: staleCount || undefined,
  })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function resolveNow(now) {
  if (typeof now === 'function') return now
  if (typeof now === 'string') {
    const parsed = Date.parse(now)
    if (Number.isFinite(parsed)) return () => parsed
  }
  if (typeof now === 'number' && Number.isFinite(now)) return () => now
  return () => Date.now()
}

function normalizeTaskStatus(status) {
  const text = String(status || '').toLowerCase()
  if (!text) return 'unknown'
  if (['completed', 'partial', 'blocked', 'failed', 'skipped', 'cancelled', 'running', 'pending'].includes(text)) return text
  if (text === 'timed_out' || text === 'timedout') return 'timedOut'
  return text
}

function normalizeRunStatus(status) {
  const text = String(status || '').toLowerCase()
  if (!text) return 'unknown'
  if (['running', 'completed', 'partial', 'blocked', 'failed', 'skipped', 'cancelled', 'unknown', 'list'].includes(text)) return text
  if (text === 'pending' || text === 'queued') return 'running'
  if (text === 'timed_out' || text === 'timedout' || text === 'timeout') return 'failed'
  if (text === 'incomplete_or_unreadable' || text === 'incomplete' || text === 'unreadable') return 'unknown'
  return 'unknown'
}

function normalizeFileChange(file) {
  if (!file || typeof file !== 'object') return null
  const filePath = String(file.path || file.file || '').trim()
  if (!filePath) return null
  return pruneUndefined({
    path: filePath,
    change: file.change ? String(file.change) : undefined,
  })
}

function normalizeRisk(risk) {
  if (!risk || typeof risk !== 'object') return null
  const text = String(risk.risk || risk.description || '').trim()
  if (!text) return null
  return pruneUndefined({
    risk: snippet(text, SNIPPET_LIMIT),
    severity: ['high', 'medium', 'low'].includes(risk.severity) ? risk.severity : 'low',
    mitigation: risk.mitigation ? snippet(String(risk.mitigation), SNIPPET_LIMIT) : undefined,
  })
}

function normalizeVerification(item) {
  if (!item || typeof item !== 'object') return null
  const label = item.check || item.command || item.name || ''
  if (!label) return null
  return pruneUndefined({
    check: redactForDisplay(label),
    status: mapCheckStatus(item.status),
    evidence: item.evidence || item.notes || item.detail ? redactForDisplay(item.evidence || item.notes || item.detail) : undefined,
  })
}

function normalizeCommand(item) {
  if (!item || typeof item !== 'object') return null
  const command = item.command || item.check || item.name || ''
  if (!command) return null
  return pruneUndefined({
    label: commandLabel(command),
    command: redactForDisplay(command),
    status: mapCheckStatus(item.status),
    notes: item.notes ? redactForDisplay(item.notes) : undefined,
  })
}

function collectNextSteps(steps) {
  if (!Array.isArray(steps)) return undefined
  const out = []
  const seen = new Set()
  for (const step of steps) {
    const text = snippet(String(step || '').trim(), SNIPPET_LIMIT)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= MAX_NEXT_ACTIONS) break
  }
  return out.length ? out : undefined
}

function statusKey(status) {
  const text = String(status || '').toLowerCase()
  if (!text) return 'pending'
  if (text === 'completed') return 'completed'
  if (text === 'partial') return 'partial'
  if (text === 'blocked') return 'blocked'
  if (text === 'failed') return 'failed'
  if (text === 'skipped') return 'skipped'
  if (text === 'cancelled') return 'cancelled'
  if (text === 'timed_out' || text === 'timedout') return 'timedOut'
  if (text === 'running') return 'running'
  if (text === 'pending') return 'pending'
  return 'partial'
}

function resolveObservability(taskLike, parsed = {}) {
  const explicit = firstString(taskLike?.observability, parsed?.observability)
  if (OBSERVABILITY_VALUES.has(explicit)) return explicit
  const runtime = firstString(taskLike?.runtime, parsed?.workerRuntime, parsed?.runtime)
  const dispatcher = firstString(taskLike?.dispatcher, parsed?.dispatcher)
  if (runtime === 'claude' || dispatcher === 'scp-claude') return 'live'
  if (runtime === 'codex' || dispatcher === 'codex-worker') return 'summary-only'
  return undefined
}

function compareActiveTaskView(a, b) {
  const started = compareTimestampValue(a?.startedAt, b?.startedAt)
  if (started !== 0) return started
  const taskId = compareText(a?.taskId, b?.taskId)
  if (taskId !== 0) return taskId
  return compareText(a?.title, b?.title)
}

function compareTimestampValue(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const aMs = Date.parse(a)
  const bMs = Date.parse(b)
  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs
  return compareText(a, b)
}

function compareText(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function mapCheckStatus(status) {
  const text = String(status || '').toLowerCase()
  if (['passed', 'pass', 'success', 'succeeded', 'ok', 'completed'].includes(text)) return 'passed'
  if (['failed', 'fail', 'error'].includes(text)) return 'failed'
  if (['skipped', 'skip'].includes(text)) return 'skipped'
  return 'notRun'
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const key of keys) {
    if (typeof obj[key] === 'number' && Number.isFinite(obj[key])) return obj[key]
  }
  return undefined
}

function snippet(text, limit) {
  const value = String(text == null ? '' : text).trim().replace(/\s+/g, ' ')
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 3)}...`
}

// Display-safe redaction for command bodies and other fields that may carry
// secrets. Masks `<hint>=value` / `<hint>:value` pairs and `Bearer <token>`
// where the key hints at a credential, then truncates to `limit`. This is a
// best-effort display filter, not a security boundary — raw prompts, stdout,
// stderr, env, and full command bodies are never placed in the desktop view in
// the first place; this only sanitizes the small command/verification snippets
// that do surface for human readability.
const SECRET_PAIR_RE = /([A-Za-z0-9_\-]*(?:secret|password|passwd|pwd|token|api[-_]?key|auth|credential|private[-_]?key)[A-Za-z0-9_\-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s;&|]+)/gi
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._\-+/=]+/gi

function redactForDisplay(text, limit = SNIPPET_LIMIT) {
  let out = String(text == null ? '' : text)
  out = out.replace(SECRET_PAIR_RE, '$1=***')
  out = out.replace(BEARER_RE, '$1 ***')
  return snippet(out, limit)
}

// A short display label for a command line: the program name with any leading
// `ENV=value` assignments stripped, redacted and capped. Lets a UI render a
// one-word action ("git", "npm") without echoing the full argument body.
function commandLabel(command) {
  const text = String(command == null ? '' : command).trim().replace(/\s+/g, ' ')
  if (!text) return null
  const tokens = text.split(' ').filter(Boolean)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1
  const prog = tokens[i] || tokens[0] || ''
  return redactForDisplay(prog, 80)
}

// path.join but tolerant of null/undefined inputs (returns null so callers can
// prune). Avoids importing node:path just for a separator join while keeping
// cross-platform path separators from the input prefix.
function joinPosix(dir, name) {
  if (!dir) return null
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

function basename(dir) {
  if (!dir) return null
  const cleaned = String(dir).replace(/[\\/]+$/, '')
  const match = cleaned.match(/[\\/]?([^\\/]+)$/)
  return match ? match[1] : cleaned
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue
    out[key] = val
  }
  return out
}

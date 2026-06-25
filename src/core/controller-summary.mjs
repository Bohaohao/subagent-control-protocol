// Controller-friendly summary of a subagent run.
//
// buildControllerSummary() takes whatever shape the SCP runtime hands a controller
// - a final run-summary.json, a subagent_collect payload (done or in-progress),
// a subagent_status single/list payload, or a bare run summary - and reduces it
// to a compact, decision-useful object: run id/status, task counts, active and
// stalled tasks, aggregated changed files with ownership-collision detection,
// key risks, a verification roll-up, measured token/cost evidence, next actions,
// and artifact paths. It never echoes logs, diffs, or file contents - only paths
// and short evidence snippets.
//
// No external dependencies. Node builtins only.

import path from 'node:path'

const DEFAULT_STALE_MS = 120_000
const DEFAULT_NOW = () => Date.now()
const SNIPPET_LIMIT = 200
const MAX_RISKS = 8
const MAX_NEXT_ACTIONS = 10
const MAX_RECENT_EVENTS = 8

// Public entry point.
export function buildControllerSummary(runSummaryOrStatus, options = {}) {
  const now = typeof options.now === 'function' ? options.now : DEFAULT_NOW
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS
  const { summary, runtime, mode } = unwrap(runSummaryOrStatus)

  if (mode === 'status-list') {
    return buildListSummary(runtime, { now, staleMs })
  }

  const tasks = collectTasks(summary, runtime)
  const taskEventMap = buildTaskEventMap(runtime.taskEvents, summary)
  const active = collectActive(runtime.active, taskEventMap)
  const counts = countTasks(summary, tasks)
  const status = resolveStatus(summary, runtime, counts)
  const phase = runtime.done === false ? 'in_progress' : 'final'

  const changedFiles = aggregateChangedFiles(tasks)
  const ownershipViolations = changedFiles.filter((file) => file.tasks.length > 1)
  const keyRisks = aggregateRisks(tasks)
  const verificationSummary = aggregateVerification(tasks)
  const tokenCost = aggregateTokenCost(summary, tasks)
  const staleOrStalled = detectStaleOrStalled(active, taskEventMap, { now, staleMs })
  const nextActions = aggregateNextActions(tasks, counts, staleOrStalled)
  const artifacts = buildArtifacts(summary, tasks)

  const out = {
    runId: summary?.runId || runtime.runId || null,
    runDir: summary?.runDir || runtime.runDir || null,
    status,
    phase,
    counts,
    activeTasks: active,
    staleOrStalled,
    changedFiles,
    ownershipViolations: ownershipViolations.length ? ownershipViolations : undefined,
    keyRisks,
    verificationSummary,
    tokenCost,
    nextActions,
    artifacts,
  }

  if (summary?.recovered) out.recovered = true
  if (summary?.error) out.error = snippet(String(summary.error), SNIPPET_LIMIT)
  if (summary?.dryRun) out.dryRun = true
  if (runtime.recentEvents?.length) {
    out.recentEvents = runtime.recentEvents.slice(-MAX_RECENT_EVENTS).map(trimEvent)
  }

  // Drop undefined top-level keys so the payload stays compact.
  return pruneUndefined(out)
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

// Reduce the heterogeneous input shapes to a common { summary, runtime, mode }
// triple. `summary` is the underlying run-summary object (may be missing for an
// in-progress run with no run-summary.json yet); `runtime` carries the
// event/active-process context that only collect/status payloads provide.
function unwrap(payload) {
  if (!payload || typeof payload !== 'object') {
    return { summary: null, runtime: {}, mode: 'unknown' }
  }

  // subagent_status list mode: no single run to summarize.
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

  // subagent_collect payload (done or in-progress) and subagent_status single
  // mode both surface a `summary` plus live runtime context.
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
      },
      mode: payload.mode === 'single' ? 'status-single' : 'collect',
    }
  }

  // Bare run-summary.json shape.
  if (payload.totalTasks !== undefined || Array.isArray(payload.tasks) || payload.runId) {
    return { summary: payload, runtime: {}, mode: 'run-summary' }
  }

  return { summary: payload, runtime: {}, mode: 'unknown' }
}

// Collect the task-result objects we actually summarize. Prefers the run
// summary's `tasks` array; falls back to collect's top-level `results` (which is
// the same array under a different name) and to status payloads that only carry
// `taskEvents` (in-progress runs with no persisted results yet).
function collectTasks(summary, runtime) {
  const fromSummary = summary && Array.isArray(summary.tasks) ? summary.tasks : []
  const fromResults = !fromSummary.length && Array.isArray(runtime.results) ? runtime.results : []
  const candidates = fromSummary.length ? fromSummary : fromResults
  return candidates.filter((task) => task && typeof task === 'object' && task.id)
}

function buildTaskEventMap(taskEvents, summary) {
  const map = new Map()
  if (Array.isArray(taskEvents)) {
    for (const entry of taskEvents) {
      if (entry && entry.taskId) map.set(entry.taskId, entry)
    }
  }
  // run-summary.json may already carry an inline `events` block per task (the
  // collect path mutates the in-memory summary to attach it). Fold those in too.
  if (summary && Array.isArray(summary.tasks)) {
    for (const task of summary.tasks) {
      if (task?.id && task.events && !map.has(task.id)) map.set(task.id, task.events)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Counts / status
// ---------------------------------------------------------------------------

function countTasks(summary, tasks) {
  const empty = { total: 0, completed: 0, partial: 0, blocked: 0, failed: 0, skipped: 0, cancelled: 0, timedOut: 0 }
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
    }
  }
  for (const task of tasks) {
    const key = statusKey(task.status)
    empty[key] += 1
    empty.total += 1
  }
  return empty
}

function resolveStatus(summary, runtime, counts) {
  if (runtime && typeof runtime.status === 'string' && runtime.status !== 'running') {
    return runtime.status
  }
  if (runtime?.done === false) return 'running'
  if (summary && typeof summary.status === 'string') return summary.status
  if (summary?.error) return 'failed'
  if (counts.cancelled > 0) return 'cancelled'
  if (counts.failed > 0 || counts.timedOut > 0) return 'failed'
  if (counts.blocked > 0) return 'blocked'
  if (counts.total > 0 && counts.completed + counts.partial >= counts.total) return 'completed'
  if (counts.total > 0) return 'partial'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Active tasks + stale/stalled detection
// ---------------------------------------------------------------------------

function collectActive(active, taskEventMap) {
  if (!Array.isArray(active)) return []
  return active
    .filter((record) => record && record.taskId)
    .map((record) => {
      const events = taskEventMap.get(record.taskId) || {}
      return pruneUndefined({
        taskId: record.taskId,
        title: record.title || undefined,
        pid: record.pid ?? undefined,
        startedAt: record.startedAt || undefined,
        lastEventAt: record.lastEventAt || events.lastEventAt || undefined,
        lastHeartbeatAt: events.lastHeartbeatAt || undefined,
        phase: events.phase || undefined,
        latestSummary: events.latestSummary ? snippet(events.latestSummary, SNIPPET_LIMIT) : undefined,
        eventLogPath: record.eventLogPath || events.eventLogPath || undefined,
      })
    })
}

// Surface hints about tasks that look stuck. Only meaningful when event data is
// present. A task is "stale" when its last heartbeat is older than staleMs;
// "stalled" when it is active but has produced no heartbeat (or no events at
// all); "blocked" when its event stream records a blocked reason.
function detectStaleOrStalled(active, taskEventMap, { now, staleMs }) {
  const hints = []
  for (const task of active) {
    const events = taskEventMap.get(task.taskId) || {}
    const blockedReason = events.blockedReason
    if (blockedReason) {
      hints.push({ taskId: task.taskId, hint: 'blocked', reason: snippet(blockedReason, SNIPPET_LIMIT), lastHeartbeatAt: events.lastHeartbeatAt })
      continue
    }
    const heartbeat = events.lastHeartbeatAt || task.lastHeartbeatAt
    const lastEvent = events.lastEventAt || task.lastEventAt
    const reference = heartbeat || lastEvent
    if (reference) {
      const ageMs = now() - Date.parse(reference)
      if (Number.isFinite(ageMs) && ageMs > staleMs) {
        hints.push({ taskId: task.taskId, hint: 'stale', ageMs, lastHeartbeatAt: heartbeat || undefined, lastEventAt: lastEvent || undefined })
      }
    } else if (events.eventCount === 0 || events.eventCount === undefined) {
      // Active process but no event signal at all yet - likely just spawned, but
      // worth flagging so the controller can re-check.
      hints.push({ taskId: task.taskId, hint: 'stalled', reason: 'active with no heartbeat events', startedAt: task.startedAt })
    }
  }
  return hints
}

// ---------------------------------------------------------------------------
// Changed files + ownership collisions
// ---------------------------------------------------------------------------

function aggregateChangedFiles(tasks) {
  const byPath = new Map()
  for (const task of tasks) {
    const files = task?.parsed?.filesChanged
    if (!Array.isArray(files)) continue
    for (const file of files) {
      const filePath = String(file?.path || file?.file || '').trim()
      if (!filePath) continue
      const entry = byPath.get(filePath) || { path: filePath, tasks: [], change: '' }
      if (!entry.tasks.includes(task.id)) entry.tasks.push(task.id)
      if (!entry.change && file.change) entry.change = snippet(String(file.change), SNIPPET_LIMIT)
      byPath.set(filePath, entry)
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

function aggregateRisks(tasks) {
  const collected = []
  for (const task of tasks) {
    const risks = task?.parsed?.risks
    if (!Array.isArray(risks)) continue
    for (const risk of risks) {
      const text = String(risk?.risk || risk?.description || '').trim()
      if (!text) continue
      collected.push({
        taskId: task.id,
        risk: snippet(text, SNIPPET_LIMIT),
        severity: ['high', 'medium', 'low'].includes(risk?.severity) ? risk.severity : 'low',
        mitigation: risk?.mitigation ? snippet(String(risk.mitigation), SNIPPET_LIMIT) : undefined,
      })
    }
  }
  const rank = { high: 0, medium: 1, low: 2 }
  collected.sort((a, b) => rank[a.severity] - rank[b.severity])
  return pruneUndefinedArray(collected.slice(0, MAX_RISKS))
}

// ---------------------------------------------------------------------------
// Verification roll-up
// ---------------------------------------------------------------------------

function aggregateVerification(tasks) {
  const tally = { passed: 0, failed: 0, skipped: 0, notRun: 0 }
  const failedChecks = []
  for (const task of tasks) {
    const parsed = task?.parsed || {}
    for (const item of [...(parsed.verification || []), ...(parsed.commandsRun || [])]) {
      const status = mapCheckStatus(item?.status)
      tally[status] += 1
      if (status === 'failed') {
        const label = item.check || item.command || item.name || 'check'
        const evidence = item.evidence || item.notes || item.detail || ''
        failedChecks.push({
          taskId: task.id,
          check: snippet(String(label), SNIPPET_LIMIT),
          evidence: evidence ? snippet(String(evidence), SNIPPET_LIMIT) : undefined,
        })
      }
    }
  }
  return pruneUndefined({
    tally,
    failedChecks: failedChecks.length ? failedChecks.slice(0, 12) : [],
    allPassed: tally.failed === 0 && tally.passed > 0 && tally.notRun === 0 && tally.skipped === 0,
  })
}

// ---------------------------------------------------------------------------
// Token / cost evidence
// ---------------------------------------------------------------------------

function aggregateTokenCost(summary, tasks) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreate = 0
  let cost = 0
  let measured = false
  const perTaskNotes = []

  for (const task of tasks) {
    const usage = task.usage
    if (usage && typeof usage === 'object') {
      const inT = pickNum(usage, ['input_tokens', 'inputTokens', 'tokensInput'])
      const outT = pickNum(usage, ['output_tokens', 'outputTokens', 'tokensOutput'])
      const cr = pickNum(usage, ['cache_read_input_tokens', 'cacheReadInputTokens'])
      const cc = pickNum(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens'])
      const c = pickNum(usage, ['cost_usd', 'costUsd']) ?? pickNum(task, ['costUsd']) ?? pickNum(task?.parsed?.metrics, ['costUsd', 'cost_usd'])
      if (inT != null) { input += inT; measured = true }
      if (outT != null) { output += outT; measured = true }
      if (cr != null) { cacheRead += cr; measured = true }
      if (cc != null) { cacheCreate += cc; measured = true }
      if (c != null) { cost += c; measured = true }
    }
    if (typeof task.measuredUsageSummary === 'string' && task.measuredUsageSummary) {
      perTaskNotes.push({ taskId: task.id, note: snippet(task.measuredUsageSummary, SNIPPET_LIMIT) })
    }
  }

  const totals = pruneUndefined({
    input: measured && input ? input : undefined,
    output: measured && output ? output : undefined,
    cacheRead: measured && cacheRead ? cacheRead : undefined,
    cacheCreate: measured && cacheCreate ? cacheCreate : undefined,
    total: measured && (input || output) ? input + output + cacheRead + cacheCreate : undefined,
    costUsd: measured && cost ? Number(cost.toFixed(6)) : undefined,
  })

  return pruneUndefined({
    measured,
    totals,
    note: measured
      ? `Aggregated measured usage across ${tasks.length} task(s); prefer over subagent self-report.`
      : 'No measured usage was available in the Claude CLI envelopes.',
    perTask: perTaskNotes.length ? perTaskNotes.slice(0, 12) : undefined,
  })
}

// ---------------------------------------------------------------------------
// Next actions
// ---------------------------------------------------------------------------

function aggregateNextActions(tasks, counts, staleOrStalled) {
  const actions = []
  if (counts.failed > 0) {
    actions.push(`Investigate ${counts.failed} failed task(s) before integrating.`)
  }
  if (counts.timedOut > 0) {
    actions.push(`Re-run or raise timeout for ${counts.timedOut} timed-out task(s).`)
  }
  if (counts.blocked > 0) {
    actions.push(`Unblock ${counts.blocked} blocked task(s).`)
  }
  for (const hint of staleOrStalled) {
    actions.push(`Re-check stalled/stale task ${hint.taskId} (${hint.hint}).`)
  }

  const seen = new Set()
  for (const task of tasks) {
    const steps = task?.parsed?.nextSteps
    if (!Array.isArray(steps)) continue
    for (const step of steps) {
      const text = snippet(String(step || '').trim(), SNIPPET_LIMIT)
      if (!text || seen.has(text)) continue
      seen.add(text)
      actions.push(text)
      if (actions.length >= MAX_NEXT_ACTIONS) return actions
    }
  }
  return actions
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function buildArtifacts(summary, tasks) {
  const runDir = summary?.runDir || null
  const taskArtifacts = tasks.map((task) => pruneUndefined({
    taskId: task.id,
    taskDir: task.taskDir || undefined,
    resultPath: task.taskDir ? path.join(task.taskDir, 'result.json') : undefined,
    eventLogPath: task.eventLogPath || (task.taskDir ? path.join(task.taskDir, 'events.jsonl') : undefined),
  }))
  return pruneUndefined({
    runDir,
    runSummaryPath: runDir ? path.join(runDir, 'run-summary.json') : undefined,
    runInputPath: runDir ? path.join(runDir, 'run-input.json') : undefined,
    tasks: taskArtifacts,
  })
}

// ---------------------------------------------------------------------------
// List-mode summary (subagent_status with mode: 'list')
// ---------------------------------------------------------------------------

function buildListSummary(runtime, { now, staleMs }) {
  const runs = (runtime.runs || []).map((run) => {
    if (!run || typeof run !== 'object') return null
    if (run.status === 'incomplete_or_unreadable') {
      return { runDir: run.runDir || null, status: 'incomplete_or_unreadable' }
    }
    return pruneUndefined({
      runId: run.runId || (run.runDir ? path.basename(run.runDir) : undefined),
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

  return {
    phase: 'list',
    status: 'list',
    outputDir: runtime.outputDir || null,
    runs,
    activeTasks: collectActive(runtime.active, new Map()),
    staleOrStalled: [],
    counts: { total: runs.length },
    statusEvents: runtime.statusEvents || undefined,
  }
}

function deriveRunStatusLite(run) {
  if (typeof run.status === 'string') return run.status
  if (run.error) return 'failed'
  if (num(run.failedTasks) || num(run.timedOutTasks)) return 'failed'
  if (num(run.blockedTasks)) return 'blocked'
  if (num(run.cancelledTasks)) return 'cancelled'
  const total = num(run.totalTasks)
  if (total > 0 && num(run.completedTasks) + num(run.partialTasks) >= total) return 'completed'
  if (total > 0) return 'running'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function statusKey(status) {
  const text = String(status || '').toLowerCase()
  if (text === 'completed') return 'completed'
  if (text === 'partial') return 'partial'
  if (text === 'blocked') return 'blocked'
  if (text === 'failed') return 'failed'
  if (text === 'skipped') return 'skipped'
  if (text === 'cancelled') return 'cancelled'
  if (text === 'timed_out' || text === 'timedout') return 'timedOut'
  return 'partial'
}

function mapCheckStatus(status) {
  const text = String(status || '').toLowerCase()
  if (['passed', 'pass', 'success', 'succeeded', 'ok', 'completed'].includes(text)) return 'passed'
  if (['failed', 'fail', 'error'].includes(text)) return 'failed'
  if (['skipped', 'skip'].includes(text)) return 'skipped'
  return 'notRun'
}

function snippet(text, limit) {
  const value = String(text == null ? '' : text).trim().replace(/\s+/g, ' ')
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 3)}...`
}

function trimEvent(event) {
  if (!event || typeof event !== 'object') return null
  const out = {}
  for (const key of ['type', 'timestamp', 'taskId', 'phase', 'message', 'summary', 'reason', 'label', 'command', 'status', 'exitCode', 'timedOut', 'cancelled', 'durationMs', 'pid']) {
    if (event[key] !== undefined) out[key] = event[key]
  }
  if (out.timestamp === undefined && event.ts !== undefined) out.timestamp = event.ts
  for (const key of ['message', 'summary', 'reason']) {
    if (typeof out[key] === 'string') out[key] = snippet(out[key], SNIPPET_LIMIT)
  }
  return pruneUndefined(out)
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

function pruneUndefinedArray(items) {
  return items.map((item) => pruneUndefined(item))
}

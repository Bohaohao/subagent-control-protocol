// Standalone event protocol & heartbeat monitoring primitives shared by the
// scheduler and the MCP status surface. Has no dependency on the scheduler
// (avoids a circular import) and only uses Node builtins.
//
// Events are compact one-line JSON objects appended to a per-task events.jsonl.
// Each carries a short `type`, an ISO `timestamp`, and a brief text field. This
// module normalizes/validates them, trims them for compact transport, and
// reduces an event list to a status summary the controller can act on.

import fs from 'node:fs/promises'

// --- Standard event types ---------------------------------------------------

export const EVENT_TYPES = Object.freeze({
  TASK_STARTED: 'task_started',
  PROCESS_STARTED: 'process_started',
  PHASE_STARTED: 'phase_started',
  HEARTBEAT: 'heartbeat',
  CHECKPOINT: 'checkpoint',
  BLOCKED: 'blocked',
  COMMAND_STARTED: 'command_started',
  COMMAND_FINISHED: 'command_finished',
  PROCESS_EXITED: 'process_exited',
  TASK_COMPLETED: 'task_completed',
  TASK_PARTIAL: 'task_partial',
  TASK_FAILED: 'task_failed',
  TASK_CANCELLED: 'task_cancelled',
  TASK_TIMED_OUT: 'task_timed_out',
  TASK_BLOCKED: 'task_blocked',
})

// Terminal task lifecycle events and the run-level status they map to. The
// last terminal event seen (in file order) wins.
export const TERMINAL_EVENT_TO_STATUS = Object.freeze({
  [EVENT_TYPES.TASK_COMPLETED]: 'completed',
  [EVENT_TYPES.TASK_PARTIAL]: 'partial',
  [EVENT_TYPES.TASK_FAILED]: 'failed',
  [EVENT_TYPES.TASK_CANCELLED]: 'cancelled',
  [EVENT_TYPES.TASK_TIMED_OUT]: 'timed_out',
  [EVENT_TYPES.TASK_BLOCKED]: 'blocked',
})

export const ALL_EVENT_TYPES = new Set(Object.values(EVENT_TYPES))

export function isTerminalEvent(event) {
  return Boolean(event && Object.prototype.hasOwnProperty.call(TERMINAL_EVENT_TO_STATUS, event.type))
}

// Heartbeats are expected roughly every 45s, so 90s without one is "stalled";
// 180s without any event at all is "slow". These are defaults only - callers
// (and tests) override them via assessHeartbeat/summarizeEvents options.
export const DEFAULT_STALE_HEARTBEAT_MS = 90_000
export const DEFAULT_SLOW_EVENT_MS = 180_000

// --- Normalize / validate ---------------------------------------------------

// Coerce a raw value into a plain event object. Never throws: returns null for
// anything that is not a non-null plain object. Normalizes `ts` -> `timestamp`.
export function normalizeEvent(raw) {
  if (!isPlainObject(raw)) return null
  const event = { ...raw }
  const timestamp = event.timestamp ?? event.ts
  if (timestamp !== undefined) event.timestamp = timestamp
  delete event.ts
  return event
}

// A raw value is malformed (for counting purposes) when it is not a non-null
// plain object - i.e. a parse failure or wrong shape. An object that is merely
// missing optional fields is NOT malformed.
export function isMalformedEvent(raw) {
  return !isPlainObject(raw)
}

export function isValidEvent(raw) {
  const event = normalizeEvent(raw)
  return Boolean(event) && typeof event.type === 'string' && event.type.length > 0
}

// Parse one JSONL line. Empty/whitespace lines are skipped (ok:false, not
// malformed); unparseable or non-object JSON is malformed.
export function parseEventLine(line) {
  const text = typeof line === 'string' ? line.trim() : ''
  if (!text) return { ok: false }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, malformed: true }
  }
  if (!isPlainObject(value)) return { ok: false, malformed: true }
  return { ok: true, event: normalizeEvent(value) }
}

// --- Trim -------------------------------------------------------------------

// Whititelist of fields kept on trimmed events. Mirrors the existing
// subagent_status recentEvents shape, plus the compact controller-facing hints
// (sequence, progress, severity, needsController, etaSeconds) preserved when
// present.
const TRIMMED_FIELDS = [
  'type',
  'timestamp',
  'runId',
  'taskId',
  'phase',
  'message',
  'summary',
  'reason',
  'label',
  'command',
  'status',
  'exitCode',
  'signal',
  'timedOut',
  'cancelled',
  'durationMs',
  'pid',
  'title',
  'kind',
  'dryRun',
  'sequence',
  'progress',
  'severity',
  'needsController',
  'etaSeconds',
  'source',
  'lastActivityAt',
]

// Trim an event to a small whitelist so recentEvents payloads stay compact.
// Returns null for non-objects.
export function trimEvent(event) {
  if (!isPlainObject(event)) return null
  const out = {}
  for (const key of TRIMMED_FIELDS) {
    if (event[key] !== undefined) out[key] = event[key]
  }
  const ts = out.timestamp ?? event.ts
  if (ts !== undefined) out.timestamp = ts
  return out
}

// --- Summarize --------------------------------------------------------------

// Synchronous core: reduce a pre-parsed event list to a status summary.
// Non-object entries are counted as malformed and skipped; never throws.
export function summarizeEventList(events, eventLogPath) {
  const summary = {
    eventLogPath: eventLogPath || undefined,
    eventCount: 0,
    malformedEventCount: 0,
    lastEventAt: undefined,
    lastHeartbeatAt: undefined,
    latestCheckpointAt: undefined,
    phase: undefined,
    blockedReason: undefined,
    latestSummary: undefined,
    terminalStatus: undefined,
    needsControllerFlag: false,
    etaSeconds: undefined,
    // Internal: type of the most recent "significant" event (terminal, blocked,
    // heartbeat, checkpoint). Used so statusHint reflects current state rather
    // than the sticky blockedReason field. Stripped from summarizeEvents output.
    lastSignificantType: undefined,
  }

  const SIGNIFICANT = new Set([
    EVENT_TYPES.BLOCKED,
    EVENT_TYPES.HEARTBEAT,
    EVENT_TYPES.CHECKPOINT,
    ...Object.keys(TERMINAL_EVENT_TO_STATUS),
  ])

  const list = Array.isArray(events) ? events : []
  for (const raw of list) {
    if (!isPlainObject(raw)) {
      summary.malformedEventCount++
      continue
    }
    const event = normalizeEvent(raw)
    summary.eventCount++
    const { type } = event
    const ts = event.timestamp
    const epoch = toEpochMs(ts)
    if (epoch !== undefined) summary.lastEventAt = ts

    if (type === EVENT_TYPES.HEARTBEAT && epoch !== undefined) {
      summary.lastHeartbeatAt = ts
    }
    if (type === EVENT_TYPES.PHASE_STARTED) {
      summary.phase = event.phase || event.phaseName || event.message || summary.phase
    }
    if (type === EVENT_TYPES.BLOCKED || type === 'block' || type === 'stuck') {
      summary.blockedReason = event.reason || event.message || summary.blockedReason
    }
    if (type === EVENT_TYPES.CHECKPOINT && epoch !== undefined) {
      summary.latestCheckpointAt = ts
    }
    if (
      type === EVENT_TYPES.CHECKPOINT ||
      type === EVENT_TYPES.HEARTBEAT ||
      type === 'message' ||
      type === 'summary'
    ) {
      const text = event.summary || event.message
      if (text) summary.latestSummary = text
    }
    if (TERMINAL_EVENT_TO_STATUS[type]) {
      summary.terminalStatus = TERMINAL_EVENT_TO_STATUS[type]
    }
    if (SIGNIFICANT.has(type)) {
      summary.lastSignificantType = type
    }
    if (event.needsController === true) summary.needsControllerFlag = true
    if (event.etaSeconds !== undefined) summary.etaSeconds = event.etaSeconds
  }
  return summary
}

// Reduce a list of compact events to a status summary. `events` may be a
// pre-parsed array (the common path) or null/undefined to read & parse
// `eventLogPath`. Malformed entries are counted but never throw.
//
// Returns: eventCount, malformedEventCount, lastEventAt, lastHeartbeatAt,
// latestCheckpointAt, phase, blockedReason, latestSummary, terminalStatus,
// etaSeconds, plus the heartbeat-assessment fields heartbeatAgeMs, stalled,
// slow, needsController, statusHint.
export async function summarizeEvents(events, eventLogPath, options = {}) {
  let resolved = Array.isArray(events) ? events : null
  let fileMalformed = 0
  if (resolved === null && eventLogPath) {
    const read = await readEventLog(eventLogPath)
    resolved = read.events
    fileMalformed = read.malformedCount
  }
  const base = summarizeEventList(resolved, eventLogPath)
  base.malformedEventCount += fileMalformed
  const assessed = assessHeartbeat(base, options)
  const { lastSignificantType, ...publicFields } = { ...base, ...assessed }
  return publicFields
}

// --- Heartbeat assessment ---------------------------------------------------

// Assess liveness from a summary (or a raw event list, which is summarized
// first). `now` is injectable for tests (a () => ms function or an epoch ms
// number); defaults to Date.now().
export function assessHeartbeat(summaryOrEvents, options = {}) {
  const base = Array.isArray(summaryOrEvents)
    ? summarizeEventList(summaryOrEvents)
    : isPlainObject(summaryOrEvents)
      ? summaryOrEvents
      : {}

  const staleHeartbeatMs = numberOr(options.staleHeartbeatMs, DEFAULT_STALE_HEARTBEAT_MS)
  const slowEventMs = numberOr(options.slowEventMs, DEFAULT_SLOW_EVENT_MS)
  const nowMs = resolveNow(options.now)

  const heartbeatMs = toEpochMs(base.lastHeartbeatAt)
  const eventMs = toEpochMs(base.lastEventAt)
  // Prefer a real heartbeat; fall back to the last event as a liveness signal.
  const livenessMs = heartbeatMs !== undefined ? heartbeatMs : eventMs

  const heartbeatAgeMs = livenessMs !== undefined ? Math.max(0, nowMs - livenessMs) : undefined
  const eventAgeMs = eventMs !== undefined ? Math.max(0, nowMs - eventMs) : undefined

  // A terminal task is done, not stalled - never flag it as stalled/slow.
  const terminal = Boolean(base.terminalStatus)
  const stalled = !terminal && heartbeatAgeMs !== undefined && heartbeatAgeMs >= staleHeartbeatMs
  const slow = !terminal && eventAgeMs !== undefined && eventAgeMs >= slowEventMs
  const explicitNeed = Boolean(base.needsControllerFlag)
  const needsController = terminal ? false : stalled || explicitNeed
  const statusHint = deriveStatusHint(base, { stalled, slow })

  return { heartbeatAgeMs, stalled, slow, needsController, statusHint }
}

function deriveStatusHint(base, { stalled, slow }) {
  if (base.terminalStatus) return base.terminalStatus
  // A blocked event that nothing has followed is the most actionable current
  // state - report it even if the heartbeat is also going stale (the task is
  // waiting, not hung). An external summary without lastSignificantType falls
  // back to the sticky blockedReason field.
  if (base.lastSignificantType === EVENT_TYPES.BLOCKED) return 'blocked'
  if (base.lastSignificantType === undefined && base.blockedReason) return 'blocked'
  if (stalled) return 'stalled'
  if (slow) return 'slow'
  if (base.lastEventAt) return 'running'
  return 'unknown'
}

// --- Internal helpers -------------------------------------------------------

async function readEventLog(eventLogPath) {
  let text
  try {
    text = await fs.readFile(eventLogPath, 'utf8')
  } catch {
    return { events: [], malformedCount: 0 }
  }
  const events = []
  let malformedCount = 0
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEventLine(line)
    if (parsed.ok) events.push(parsed.event)
    else if (parsed.malformed) malformedCount++
  }
  return { events, malformedCount }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toEpochMs(value) {
  if (value === undefined || value === null) return undefined
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function resolveNow(now) {
  if (typeof now === 'function') {
    const value = now()
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
  }
  if (typeof now === 'number' && Number.isFinite(now)) return now
  return Date.now()
}

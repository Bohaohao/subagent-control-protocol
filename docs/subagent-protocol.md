# Subagent protocol

This kit treats Codex as the controller. Claude Code CLI is the bounded executor
for the `claude` runtime through SCP MCP tools, while named Codex workers are
host-spawned by Codex for non-`claude` branches. Each worker task must return the
same base JSON shape, so the controller can merge results without reading
free-form prose.

## Core rules

1. One task has one stable `id`.
2. A task may depend on other task ids through `dependsOn`.
3. Planning, review, verification, and research tasks can run in parallel.
4. Implementation tasks should avoid editing the same files in parallel.
5. Every task writes stdout, stderr, prompt, raw CLI output, and parsed result
   under one run directory.
6. A task is not considered done until its result JSON contains verification
   evidence or a clear reason verification was skipped.
7. Pure reporting tasks should set `"tools": []` to force `--tools ""`.
8. Avoid `permissionMode: "plan"` for one-shot JSON tasks; it can trigger a
   plan-exit flow instead of a direct answer.

## Required subagent result

The result must match `schemas/agent-result.schema.json`:

- `status`: `completed`, `partial`, `blocked`, or `failed`
- `summary`: short factual outcome
- `filesChanged`: changed files and what changed
- `commandsRun`: commands and pass/fail/skipped state
- `verification`: checks with evidence
- `risks`: remaining risks with severity
- `nextSteps`: concrete next actions, empty when none
- `tokenUsageSummary`: Claude-authored note about token visibility; it must not
  invent exact counts
- `metrics`: optional token/cost fields when available

Codex worker final messages use the same base shape and should also include
worker identity fields when available:

- `workerRuntime`: `codex`
- `workerType`: resolved worker type such as `huoshan-worker`, `zhipu-worker`,
  or `normal-worker`
- `workerAlias`: optional user-facing alias such as `huoshan`
- `fallbackApplied`: optional boolean, `true` when a requested worker fell back
  to another worker type

The controller wraps each task with measured process metadata. Top-level task
status may also be `skipped`, `timed_out`, or `cancelled`. When the Claude CLI
reports measured usage, the controller records `usage` plus
`measuredUsageSummary` alongside Claude's own `tokenUsageSummary`.

The runtime also repairs common Claude output variants before normalization:
fenced JSON, prose-wrapped JSON, Claude CLI `{ type: "result", result: "..." }`
envelopes, and common alternate field names. Repair diagnostics are kept on the
normalized result when repair happened; exact token counts are never fabricated.

## todoList-first orchestration (hard workflow)

The controller must not dispatch any task until it has produced a `todoList`.
The `todoList` is the single source of truth for what gets run, in what order,
and with what boundaries. The dispatch plan is derived directly from it — it is
not improvised after the fact.

1. **Produce the `todoList` first.** Before calling `subagent_run_many` (or
   `subagent_run_task`), the controller writes out a `todoList` with one entry
   per unit of work.
2. **Record per-todo metadata.** Each todo records:
   - `goal` — what this todo achieves in one sentence
   - `kind` — `plan` / `implement` / `review` / `verify` / `research` / `other`
   - `boundary` — the hard file/output scope (owned files, read-only, etc.)
   - `dependencies` — which other todo ids this one depends on
   - `writeStatus` — whether the todo may write (`writer`, `read-only`) and,
     for writers, the exclusive file set
   - `parallelEligible` — `true`/`false`: can this todo run alongside siblings
     without conflict
   - `acceptance` — the concrete, checkable criterion that marks it done
3. **Dispatch from the `todoList`.** Each dispatched task corresponds to a todo.
   Map `dependencies` to `dependsOn`, `writeStatus` to `tools`/`permissionMode`,
   and `parallelEligible` to the batch's `concurrency`. Independent,
   non-overlapping todos run in parallel; writers on the same file are sequenced
   or merged.
4. **Add two read-only review agents after implementation.** Whenever the
   `todoList` includes implementation writers, the controller appends two
   read-only review todos that depend on the implementers:
   - a **software-engineering review** (correctness, contracts, tests, regressions)
   - a **real-user review** (does the change actually serve the intended user
     workflow; UX/integration realism)
   Both are `kind: review`, `writeStatus: read-only`, `parallelEligible: true`,
   and never edit files.
   This is a controller-side requirement enforced by the orchestrator Skill;
   the MCP server executes the supplied plan and does not inject review tasks
   by itself.
5. **The controller integrates results.** The controller (Codex) reads each
   result, cross-checks `filesChanged` for non-overlap, runs the full
   verification matrix, folds the two reviews into a single accept/revise/hold
   decision, applies any small fix itself, and makes the final ship decision.
   A subagent never merges, releases, or declares the work complete on the
   controller's behalf.

This workflow supersedes ad-hoc decomposition. If no `todoList` exists, the
controller is not ready to dispatch.

## Mixed worker channels (Claude + Codex workers)

The controller may run a plan that mixes **Claude subagents** and **Codex
workers**. The two channels are disjoint; the controller is the only component
that spans them. The rules in this section are normative.

### Channels

1. **Claude channel.** Claude subagents execute through the SCP MCP runtime
   (`subagent_run_task`, `subagent_run_many`, `subagent_start`). Results are the
   MCP envelope: `runSummary`, `results`, and `measuredUsageSummary`. The Claude
   runner path is unchanged by the addition of Codex workers.
2. **Codex worker channel.** Codex workers are spawned by the Codex host via
   `multi_agent_v1.spawn_agent`. The SCP Node MCP runtime MUST NOT spawn Codex
   workers directly. The controller waits on each worker with `wait_agent` and
   reads its final message as the result.
3. **Single ownership.** The controller owns exactly one `todoList` and one
   `dispatchLedger`. Both channels consume the same `todoList`. The
   `dispatchLedger` records, per todo: the channel (`claude` |
   `codex-worker`), the resolved worker name, the spawn handle or run locator,
   and the status. It is the reconciliation surface between the two channels.

### Worker alias resolution & fallback

Before spawning a Codex worker, the controller resolves the requested name:

- `huoshan` → `huoshan-worker`
- `zhipu` → `zhipu-worker`
- A name already ending in `-worker` (an exact `xxx-worker`) is used as-is.
- A worker that cannot be found falls back to `normal-worker`.
- If `normal-worker` is also missing, the branch is **blocked**. The controller
  records `blocked` in the `dispatchLedger` with the reason and does not execute
  that todo.
- The controller MUST NOT fall back to the Codex default agent. Resolution
  either yields a concrete `-worker` name or blocks — never a silent default.

### Result reading & compatibility

- Claude results are read from the MCP envelope (`runSummary`, `results`,
  `measuredUsageSummary`).
- Codex worker results are read from the `wait_agent` final message. The
  controller MUST prompt each Codex worker to return JSON matching the SCP
  result contract (the same base shape Claude returns) plus `workerRuntime:
  "codex"`, the resolved `workerType`, optional `workerAlias`, and optional
  `fallbackApplied`. A worker whose final message lacks required fields may be
  sent a single `send_input` follow-up to request the missing fields; after that
  one follow-up the controller accepts the worker's reply as final and does not
  retry.
- **429 auto-continue (Codex workers only).** This recovery rule applies only to
  Codex workers; the Claude/SCP runner path is unchanged. When a Codex worker's
  `wait_agent` final status or final message clearly indicates a 429 /
  rate-limit condition, the controller sends `继续` to that worker and retries
  collection. The controller MUST make at most 3 such auto-continue attempts per
  worker; after the third it accepts the worker's last reply as final. This is
  separate from the one-time `send_input` repair above, and the two limits are
  independent. If the final status or final message is ambiguous, the controller
  does not auto-continue. Support is final-message / final-status based only — the
  controller does not promise mid-run 429 interception, and a 429 that does not
  surface in the `wait_agent` final status or final message is not
  auto-continued. The controller's final summary MUST state whether
  auto-continue happened for a worker and whether it recovered.
- The controller normalizes both channels into the same result shape before
  integration, so `filesChanged`, `commandsRun`, `verification`, `risks`, and
  `tokenUsageSummary` are comparable across channels.

### Timeout continuation rule (hard)

Timeout recovery is controller behavior, and it applies to both channels:

- When a delegated branch reaches a timeout terminal state (`timed_out` or an
  equivalent timeout result), the controller must first collect the best
  available progress and artifacts from that worker.
- The controller must then update the shared `todoList` with a continuation todo
  that records carried-forward progress, remaining work, and any missing
  context.
- The controller should dispatch a new subagent to continue from that recovered
  state.
- The controller must **not** personally take over the task by default just
  because the subagent timed out.
- Codex may personally take over only when the user explicitly instructs Codex
  to do the work itself, or explicitly stops further subagent delegation.

Channel-specific recovery sources:

- Claude channel: prefer `subagent_collect`, `subagent_status`,
  `subagent_watch`, `run-summary.json`, `result.json`, and `events.jsonl`.
- Codex worker channel: prefer the terminal `wait_agent` result plus any
  already-produced structured output from that worker.

### Compatibility (hard)

- No change to the Claude runner path.
- The SCP Node MCP runtime does not spawn Codex workers. Codex workers are
  host-spawned (`multi_agent_v1.spawn_agent`); SCP participates only as the
  Claude channel and as the shared result contract.

## Event, health, and cleanup protocol

Each task owns `tasks/<id>/events.jsonl`, an append-only JSONL event stream. The
runtime writes task/process lifecycle events and a periodic runtime `heartbeat`
while the Claude process is active. The Claude subprocess is also asked to add
compact `phase_started`, `checkpoint`, `blocked`, `command_started`, and
`command_finished` events.

`timeoutMs` is interpreted as a subagent **idle timeout**, not an absolute
wall-clock deadline. The runner only times a task out when no subagent-owned
event or heartbeat is observed for `timeoutMs`. Runtime-owned heartbeats show
that the process is alive, but they do not reset the idle timeout on their own.

A timeout terminal state should be treated as a recovery/continuation boundary,
not as permission for the controller to silently absorb the remaining work.

Events must stay small. They should include `type`, `timestamp`, `runId`,
`taskId`, and one-line context fields such as `summary`, `reason`, `phase`,
`label`, or `command`. Heartbeats may include a task-local incrementing
`sequence` in the raw task event log.
Optional controller hints include `progress`, `etaSeconds`, `severity`, and
`needsController`.

Controllers should prefer these tools over raw log reads:

- `subagent_status` for compact per-task event summaries and recent events.
- `subagent_watch` for heartbeat-derived `health`, `controllerSummary`, and
  `suggestedAction`. Use `compact: true` for high-frequency polling.
- `subagent_collect` for interim progress and final results from async runs.
- `subagent_cleanup` for dry-run-first retention cleanup of run artifacts.

For token-conscious polling, set `includeControllerSummary: false` on
`subagent_status`/`subagent_collect`, or `compact: true` on `subagent_watch`.
Cleanup defaults are conservative: `keepFailed: true` and
`includeIncomplete: false`.

Malformed event lines are ignored rather than crashing status collection. Full
`stdout.txt` and `stderr.txt` are artifact-only and should be read only for
diagnosis.

## Desktop status contract & integration boundary

SCP is the **status source**; a desktop monitor app is a **read-only observer**.
This keeps the execution boundary clean: SCP and the Codex controller own state,
dispatch, cancellation, and the final accept/ship decision. The desktop only
displays status. The desktop project is separate from this repository — SCP does
not ship the desktop app, and the desktop app is not part of this plugin bundle.

### Status source vs. observer

- **SCP owns state.** Decomposition, dispatch, process lifecycle, heartbeats,
  cancellation, and integration all stay inside SCP and the controller. Only the
  controller dispatches or cancels work.
- **The desktop owns display.** It renders run/task status, health, heartbeats,
  and events for a human. It never dispatches subagents, never cancels runs, and
  never writes into SCP run artifacts. Cancellation is an MCP-layer operation
  (`subagent_cancel`); the desktop may *surface* a stalled run but must not kill
  processes itself.

### Stable mirror

SCP writes stable, per-run artifacts under `<workspace>/.subagent-runs/<runId>/`:
`run-summary.json`, `events.jsonl`, and `tasks/<id>/result.json` +
`events.jsonl`. This artifact directory remains the source of truth.
`subagent_desktop_status` can also write an optional stable `status.json` mirror
to `SCP_STATUS_MIRROR_DIR` (or a per-user default) for external desktop widgets.

### Desktop status schema (`scp.run-view/v1`)

The desktop view model is defined by `schemas/desktop-status.schema.json` and
produced by `buildRunViewModel()` in `src/core/status-view.mjs`. It is the single
shape a desktop client renders; both `subagent_desktop_status` and the status
bridge return it. The versioning anchor is the `schema` field, not the file
path: consumers must check `schema === "scp.run-view/v1"` and tolerate
additional fields and `null` gaps (a missing or unknown value is `null`, never
an exception). Nested objects opt into `additionalProperties: true` on purpose
so the model can grow without breaking older widgets.

Version tags in play:

| Tag | Where | Meaning |
| --- | --- | --- |
| `scp.run-view/v1` | top-level `schema` | run or list view model |
| `scp.task-view/v1` | each entry in `tasks[]` | display-safe task view |
| `scp.event-view/v1` | each entry in `recentEvents[]` | render-relevant event slice |
| `scp.token-evidence/v1` | `tokenEvidence` and per-task | measured token/cost evidence |
| `scp.status-mirror/v1` | `status.json` envelope | mirror wrapper around a snapshot |
| `scp.bridge-discovery/v1` | `bridge.json` | bridge discovery payload |

The model covers two modes: `mode: "run"` (one run snapshot) and
`mode: "list"` (runs overview). UI-friendly fields a widget can render directly:

- `displayStatus` — human label (`Running`, `Completed`, `Failed`, `Blocked`,
  `Stale`, `Idle`, …).
- `statusTone` — suggested color/tone (`active`, `positive`, `warning`,
  `negative`, `neutral`).
- `progressHint` — one-line summary, e.g. `3/5 tasks, 1 failed, 1 active`.
- `health` — coarse `{ level, running, activeCount, staleCount, failedCount,
  blockedCount }`.
- `counts` — task outcome tallies.
- `counts.running` / `counts.pending` stay distinct from `counts.partial`.
- `activeTaskCount`, `lastUsefulEventAt`, `stalenessMs` — liveness signals.
  Compare `stalenessMs` against the producer-provided `staleThresholdMs` before
  flagging a run as stalled.
- `tasks[]` / `activeTasks[]` may include `runtime`, `dispatcher`,
  `workerType`, `workerAlias`, `fallbackApplied`, and `observability`.
  `observability = live` means freshness may be derived from real
  heartbeats/events; `observability = summary-only` means only summary/terminal
  visibility is expected and heartbeat absence alone must not mark the task
  stale.
- `tokenEvidence` — measured (never self-reported) usage; `measured: false`
  means no usage numbers are available.

Default privacy posture: raw prompts, `stdout`/`stderr`, env, and full command
bodies are never placed in the view in the first place. Commands and
verification snippets are reduced to a display-safe `label` (the program name,
with leading `ENV=value` assignments stripped) and a redacted, truncated
snippet. The redactor masks `<hint>=value` / `<hint>:value` pairs and
`Bearer <token>` where the key hints at a credential (`secret`, `password`,
`token`, `api[_-]key`, `auth`, `credential`, `private[_-]key`), then truncates
to a small snippet limit. **This is a best-effort display filter, not a security
boundary** — it keeps the view safe to glance at; it does not guarantee every
secret shape is removed. Treat the view as display-only.

### Status bridge contract

> **Status: implemented, opt-in.** SCP ships an optional read-only localhost
> status bridge. It is disabled by default and starts only when the controller
> calls `subagent_status_bridge` with `action: "start"`.

Read-only localhost endpoints (all `GET`, observer-side):

| Route | Mirrors | Returns |
| --- | --- | --- |
| `GET /health` | `subagent_desktop_status` | bridge health, counts, active tasks |
| `GET /runs` | `subagent_desktop_status` list mode | recent runs + active-process list |
| `GET /run/:runId` | `subagent_desktop_status` run mode | one run view model |
| `GET /events` | `recentEvents` window | bounded event tail |
| `GET /events/stream` | periodic snapshot stream | SSE `snapshot` events |

Bridge contract rules:

- **Loopback-only by default.** The bridge has no authentication, so
  `subagent_status_bridge` rejects non-loopback hosts unless
  `allowNonLoopback: true` is set explicitly.
- **Read-only.** No mutation routes. The bridge never dispatches, cancels, or
  writes run state; mutation stays on the MCP/tool layer.
- **Bound the event tail.** Mirror the `recentEventsLimit` behavior of
  `subagent_status`; never stream a full `events.jsonl`.
- **Tolerate partial state.** A run directory may be mid-write or incomplete.
  Return an explicit `incomplete_or_unreadable` status rather than failing.
- **No secrets.** Do not surface `stdout.txt`/`stderr.txt` or raw prompt bodies by
  default; expose status/health/events, not full process logs.

### Bridge discovery (`bridge.json`)

When the status bridge starts, SCP writes a small `bridge.json` discovery file
to a stable per-user location so a desktop widget can find the bridge's
host/port without scraping ports or reading scheduler internals. The file is
written atomically (temp file + rename) on start and removed on stop; a missing
or corrupt file reads back as `null`, never throws. It contains no secrets.

Fields (`schema: "scp.bridge-discovery/v1"`, `schemaVersion: 1`):

- `host`, `port` — the loopback address the bridge is listening on.
- `startedAt`, `updatedAt` — ISO timestamps.
- `pid` — OS pid of the bridge process (defaults to the writing process when not
  supplied), so a widget can correlate the file to a live process.
- `workspace`, `outputDir` — optional; the workspace/output dir the bridge is
  reporting on, when provided.

Directory resolution (first non-empty wins):

1. an explicit `discoveryDir` option;
2. the `SCP_BRIDGE_DISCOVERY_DIR` env var;
3. a stable per-user data dir — `<homedir>/.scp/bridge` (or
   `%LOCALAPPDATA%\scp\bridge` on Windows) — so discovery survives plugin cache
   reinstalls;
4. the run `outputDir` / `taskDir` as a run-local fallback.

A widget discovers the bridge by reading `bridge.json`, then connects to
`http://<host>:<port>`. The discovery file is optional end-to-end: if it is
absent the bridge may simply not be running, and the widget should retry rather
than error.

### Incremental event consumption

`GET /events` supports cursor-based incremental reads so a widget can poll
without re-fetching the whole tail:

- `afterSequence` — integer cursor; return only events with `sequence` greater
  than this. The bridge coerces it to an integer (or `null`) before handing it
  to the provider.
- `since` — ISO timestamp lower bound, passed through as a string.
- `limit` — maximum number of events to return.

The tail is always bounded: the run view model keeps at most a small
`recentEvents` window (newest last), mirroring the `recentEventsLimit` behavior
of `subagent_status`. `recentEvents` is a bounded overview window; `GET /events`
is bounded incremental retrieval over that merged run stream; the bridge never
streams a full `events.jsonl`. A widget that needs longer history should persist
its own `afterSequence` cursor between polls. `afterSequence` only applies to
events with a numeric `sequence`; null-sequence events are omitted from cursor
responses and remain visible through fresh snapshots or `since` polling. In the
desktop run view, `sequence` is a **run-global monotonic cursor** assigned to
the merged run event stream, not a task-local heartbeat counter. If a cursor
falls outside the bounded tail and returns no events, keep the last rendered
snapshot and refresh from `/run/:runId` or `/runs`.

`GET /events/stream` is an SSE channel. On connect the bridge sends a
`: connected` comment, then pushes periodic `snapshot` events (one per
provider-emitted snapshot). A `: ping` keep-alive comment is sent roughly every
15 seconds so proxies and clients can detect a dead bridge even when no events
flow. The stream is observer-only: it carries snapshots, not dispatch/cancel
control, and it is not a raw per-event pipe.

### Heartbeat semantics for observers

The runtime emits a periodic `heartbeat` event (with a monotonic `sequence`)
while a Claude child process is active, and the subprocess is asked to emit
`phase_started`, `checkpoint`, `blocked`, and `command_started`/
`command_finished`. For an observer:

- A **fresh heartbeat** means the run is alive; show the latest `phase` and
  `sequence`.
- A **stale or missing heartbeat** means "unknown / possibly stalled" — display
  it as such, but do not infer death or kill the process. The controller decides
  cancellation via `subagent_cancel` / `subagent_watch`'s `suggestedAction`; the
  desktop only surfaces the signal.
- Heartbeats are best-effort. Malformed or interleaved lines are ignored; a gap
  in `sequence` is informational, not an error.

### Read-only desktop behavior (hard rule)

The desktop app and any status bridge must be **read-only** with respect to SCP:
never write into `.subagent-runs/` or any run directory; never call
dispatch/cancel MCP tools on the controller's behalf; treat the mirror as
immutable artifacts produced by SCP. The desktop is a viewer, not a participant.

## Recommended task split

Express this split as a `todoList` (see "todoList-first orchestration" above):

- Phase A: parallel planning or analysis (`parallelEligible: true`,
  `writeStatus: read-only`)
- Phase B: single writer implements shared code (`writeStatus: writer`, sequenced
  or merged when files overlap)
- Phase C: parallel review and verification — includes the two auto-added
  read-only review agents (software-engineering + real-user) plus verifiers
- Phase D: controller integrates results, applies small fixes, runs final
  checks, reports evidence, and decides to ship

This reduces conflict while still using parallelism where it is useful.

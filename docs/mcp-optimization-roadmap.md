# MCP optimization roadmap

Subagent Control Protocol is now a first-class Codex plugin with a bundled MCP
runtime. This document tracks the remaining runtime improvements that would make
Codex-to-Claude delegation more observable, cancellable, and policy-aware.

## Current tools

### `subagent_run_task`

Input:

- `id`
- `workspace`
- `prompt`
- `model`
- `timeoutMs`
- `permissionMode`
- `allowedTools`

Output:

- `runSummary`
- `result`

### `subagent_run_many`

Input:

- `tasks`
- `concurrency`
- `workspace`
- `outputDir`

Output:

- `runSummary`

### `subagent_cancel`

Input:

- `runId`

Stops active child process trees when the MCP process can still see them, and
prevents the scheduler from starting tasks that are still pending.

### `subagent_status`

Reads `run-summary.json` or lists recent runs.

Single-run mode now surfaces compact event state: `taskEvents`,
`recentEvents`, heartbeat timestamps, `health`, and `controllerSummary`.

### `subagent_start`

Starts a dependency-aware plan in the background and immediately returns a run
locator (`runId`, `runDir`, `outputDir`, `workspace`) for later collection.

### `subagent_collect`

Collects interim progress or the final `run-summary.json` for a run started by
`subagent_start`. Supports run-id-only lookup through the persisted run
registry when the output directory can be resolved.

### `subagent_watch`

Reads controller-friendly run health without starting work. It combines
collect/status data with heartbeat-derived `health`, `controllerSummary`, and a
`suggestedAction`. It supports `compact: true` for frequent low-token polling.

### `subagent_cleanup`

Plans or executes retention cleanup for run artifact directories. Dry-run mode
is the default; deletion is restricted to direct child run directories under the
selected `outputDir`.

## Implemented optimization points

- Structured event protocol and heartbeat health summaries, including runtime
  periodic heartbeats while Claude child processes are active.
- Async start/collect workflow with persisted run registry and recovery scan.
- Controller summary aggregation for statuses, changed files, risks,
  verification, usage evidence, and artifacts.
- Result repair for fenced JSON, prose-wrapped JSON, Claude CLI envelopes, and
  common alternate field names.
- Ownership validation for read-only edits, out-of-bound file changes, and
  cross-task file collisions.
- Dry-run-first artifact cleanup with age/count/size retention options.
- Compact watch/status controls for token-conscious polling.
- Smoke coverage for async collect, watch, cleanup, and result repair.

## Next improvements

- Persist active process metadata deeply enough for cancellation to survive an
  MCP process restart, not only status lookup.
- Add a tail-reader for very large `events.jsonl` files so status does not need
  to read full event logs on huge runs.
- Add explicit workspace edit policies at the MCP schema level, beyond current
  result-time ownership validation.
- Add a small result viewer for run directories.
- Add JSON schema validation for user-provided task plans before execution.

## Implemented: desktop status bridge (opt-in)

SCP is the status source and a desktop monitor app is a read-only observer (the
desktop project is separate from this repo). SCP now exposes a desktop-facing
status snapshot through `subagent_desktop_status` and can start an optional
read-only localhost bridge through `subagent_status_bridge`. The snapshot shape
is defined by `schemas/desktop-status.schema.json` and versioned by its
top-level `schema` field (`scp.run-view/v1`); consumers check that field and
tolerate additional fields and `null` gaps.

> **Status: shipped as opt-in runtime support.** The bridge is disabled by
> default and starts only when the controller calls `subagent_status_bridge` with
> `action: "start"`.

Read-only endpoints:

- `GET /health` - bridge health, counts, and active tasks.
- `GET /runs` - recent runs and active-process list.
- `GET /run/:runId` - one desktop run view model.
- `GET /events` - bounded event tail; supports `afterSequence`, `since`, and
  `limit` for cursor-based incremental reads. `afterSequence` only includes
  events with numeric `sequence` values; clients should refresh a snapshot when
  their cursor falls outside the bounded tail.
- `GET /events/stream` - SSE stream of periodic `snapshot` events with a
  `: ping` keep-alive (~15s).

On start the bridge writes a small `bridge.json` discovery file
(`scp.bridge-discovery/v1`) to a stable per-user location
(`SCP_BRIDGE_DISCOVERY_DIR` or `<homedir>/.scp/bridge`, `%LOCALAPPDATA%\scp\bridge`
on Windows) carrying `host`/`port`/`pid`/`startedAt` and optional
`workspace`/`outputDir` — no secrets. It is removed on stop.

Contract rules for the bridge: loopback-only by default (non-loopback hosts
require `allowNonLoopback: true` because the bridge has no authentication);
read-only (no dispatch/cancel/write routes); bound the event tail; tolerate
incomplete/mid-write runs with an explicit `incomplete_or_unreadable` status;
never surface `stdout.txt`/`stderr.txt` or raw prompt bodies by default. The
view reduces commands/verification to display-safe labels and redacted snippets
(best-effort display filtering, not a security boundary).

Heartbeat semantics for observers: the runtime already writes periodic
`heartbeat` events with a monotonic `sequence` to `events.jsonl`. A fresh
heartbeat means alive; a stale/missing heartbeat means "unknown / possibly
stalled" and must **not** trigger the bridge to kill the process — cancellation
stays an MCP-layer operation (`subagent_cancel`). Malformed event lines are
ignored, and a `sequence` gap is informational, not an error.

The bridge remains read-only runtime support. Mutation (dispatch/cancel/cleanup)
stays on the MCP/tool layer, and the desktop remains a viewer rather than a
participant.

## Why MCP is better than shell

- It can preserve structured task metadata without scraping stdout.
- It can stream partial results and logs to Codex.
- It can expose real token/cost metrics when the provider supports them.
- It can enforce workspace boundaries and edit policies.
- It can handle Windows process trees reliably.

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

## Why MCP is better than shell

- It can preserve structured task metadata without scraping stdout.
- It can stream partial results and logs to Codex.
- It can expose real token/cost metrics when the provider supports them.
- It can enforce workspace boundaries and edit policies.
- It can handle Windows process trees reliably.

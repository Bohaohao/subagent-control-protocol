# MCP optimization roadmap

Subagent Control Protocol is now a first-class MCP server. This document tracks
the remaining improvements that would make Codex-to-Claude delegation more
observable, cancellable, and policy-aware.

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

## Next improvements

- Stream task progress events instead of returning only after task completion.
- Persist active process metadata so cancellation can survive client reconnects.
- Add explicit workspace edit policies, such as read-only, single-writer, and
  declared file ownership.
- Add token and cost normalization across Claude Code output variants.
- Add a small result viewer for run directories.
- Add JSON schema validation for user-provided task plans before execution.

## Why MCP is better than shell

- It can preserve structured task metadata without scraping stdout.
- It can stream partial results and logs to Codex.
- It can expose real token/cost metrics when the provider supports them.
- It can enforce workspace boundaries and edit policies.
- It can handle Windows process trees reliably.

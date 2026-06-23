# MCP optimization roadmap

The shell-based runner in this kit is a stopgap. A first-class MCP should expose
the same protocol directly.

## Proposed tools

### `subagent.spawn`

Input:

- `taskId`
- `workspace`
- `prompt`
- `outputSchema`
- `model`
- `timeoutMs`
- `budgetUsd`
- `permissionMode`
- `allowedTools`

Output:

- `taskId`
- `status`
- `result`
- `stdoutPath`
- `stderrPath`
- `artifacts`
- `metrics`
- `startedAt`
- `endedAt`

### `subagent.run_many`

Input:

- `tasks`
- `maxParallel`
- `dependencyPolicy`
- `sharedWorkspacePolicy`

Output:

- `runId`
- `maxParallelObserved`
- `results`
- `failedTasks`
- `skippedTasks`
- `summaryPath`

### `subagent.cancel`

Stops a specific task and its child process tree.

### `subagent.status`

Returns live process state, elapsed time, latest log offsets, and known costs.

## Why MCP is better than shell

- It can preserve structured task metadata without scraping stdout.
- It can stream partial results and logs to Codex.
- It can expose real token/cost metrics when the provider supports them.
- It can enforce workspace boundaries and edit policies.
- It can handle Windows process trees reliably.


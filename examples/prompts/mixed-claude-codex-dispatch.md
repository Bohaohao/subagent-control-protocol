# Mixed Claude + Codex Worker Dispatch

Use this prompt pattern when Codex should stay the controller while dispatching
both Claude subagents and named Codex workers from one `todoList`.

## Minimal Chinese Prompt

```text
开始做任务一、任务二。任务一让 claude 并行做；任务二派三个 huoshan 和三个 zhipu 并行做。

总控先拆 todoList，标出可并行点；所有派发都记录到 dispatchLedger。
claude 只走 SCP MCP；huoshan/zhipu 解析为 huoshan-worker/zhipu-worker 并通过 Codex worker 派发。
缺失 worker 时 fallback normal-worker；normal-worker 也不存在就把该分支标记 blocked，不要退回 Codex default。
所有 Claude 和 Codex worker 结果由总控统一归一、统一汇总，最后由总控决定是否接受。
```

## Vocabulary

- `runtime`: `claude` or `codex`.
- `dispatcher`: `scp-claude` for Claude, `codex-worker` for named Codex workers.
- `workerType`: resolved Codex worker type, such as `huoshan-worker`,
  `zhipu-worker`, or `normal-worker`.
- `workerAlias`: user-facing alias, such as `huoshan` or `zhipu`.
- `dispatchLedger`: controller-owned join table between `todoList`, raw handles,
  and normalized results.
- `UnifiedAgentResult`: normalized result used by the controller for final
  integration.

## Hard Rules

- Codex must create one `todoList` before dispatching anything.
- `claude` is a reserved runtime keyword and only uses SCP MCP tools.
- Non-`claude` names are Codex worker aliases. Resolve exact `xxx-worker` first;
  otherwise resolve `xxx` to `xxx-worker`.
- Missing Codex worker types fallback to `normal-worker`.
- If `normal-worker` is missing, mark that branch `blocked`.
- Never fallback to the Codex default agent.
- Writing tasks must keep single-writer file boundaries.
- Two read-only review agents still run after implementation when the
  orchestrator flow requires review.

## Codex Worker Completion JSON

Prompt every Codex worker to finish with this shape:

```json
{
  "status": "completed",
  "summary": "What this worker finished.",
  "filesChanged": [],
  "commandsRun": [],
  "verification": [],
  "risks": [],
  "nextSteps": [],
  "tokenUsageSummary": "Exact worker token usage was not visible to this worker.",
  "workerRuntime": "codex",
  "workerType": "huoshan-worker",
  "workerAlias": "huoshan",
  "fallbackApplied": false
}
```

## 429 / Rate-Limit Auto-Continue

A Codex worker branch may hit a provider rate limit. When a worker's terminal
`wait_agent` message or final status clearly indicates a 429 / rate-limit
condition, the controller auto-sends `继续` to that same worker to resume it.

- Max **3** auto-continue attempts per worker. After the third attempt, accept
  the worker's last reply as final and stop.
- This retry budget is separate from the one-time structured-result repair
  follow-up (`send_input` once to request missing result fields). The two do not
  share a counter.
- This rule applies only to Codex workers; the Claude/SCP runner path is
  unchanged.
- If the final status or final message is ambiguous, do not auto-continue.
- Auto-continue only reacts to the terminal message. Do **not** intercept a
  worker mid-run to inject `继续`; the controller waits for the final message,
  then decides.
- Record each auto-continue attempt and the final outcome in `dispatchLedger`
  next to the worker's `workerType`, `workerAlias`, and handle.

## Example 1: Claude + huoshan/zhipu

### Controller Prompt

```text
You are the controller. Produce a todoList before dispatching anything.

Task one: runtime claude. Split the work into non-overlapping implementation
slices and dispatch them in parallel through SCP MCP.

Task two: runtime codex. Dispatch three huoshan workers and three zhipu workers
in parallel through the Codex host worker API. Resolve aliases to
huoshan-worker and zhipu-worker. Give every worker a disjoint input partition.

Record every dispatch in dispatchLedger with runtime, dispatcher, workerType,
workerAlias, fallbackApplied, status, and rawHandle.

After all workers finish, normalize every result into UnifiedAgentResult,
cross-check writer file boundaries, run verification yourself, and make the
final accept/revise/hold decision yourself.
```

### Expected todoList

| id | goal | kind | runtime | dispatcher | workerType | boundary | dependencies | parallel |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `t1-impl-a` | Task one slice A | implement | claude | scp-claude |  | `src/feature/a/*` | none | true |
| `t1-impl-b` | Task one slice B | implement | claude | scp-claude |  | `src/feature/b/*` | none | true |
| `t2-huoshan-1..3` | Task two huoshan shards | implement | codex | codex-worker | huoshan-worker | disjoint input shard | none | true |
| `t2-zhipu-1..3` | Task two zhipu shards | implement | codex | codex-worker | zhipu-worker | disjoint input shard | none | true |

### Expected dispatchLedger

```json
{
  "entries": [
    {
      "todoId": "t1-impl-a",
      "runtime": "claude",
      "dispatcher": "scp-claude",
      "status": "dispatched",
      "rawHandle": { "runId": "<scp-run>", "taskId": "t1-impl-a" }
    },
    {
      "todoId": "t2-huoshan-1",
      "runtime": "codex",
      "dispatcher": "codex-worker",
      "workerType": "huoshan-worker",
      "workerAlias": "huoshan",
      "fallbackApplied": false,
      "status": "dispatched",
      "rawHandle": {
        "agentId": "ma-001",
        "agentType": "huoshan-worker",
        "nickname": "huoshan-1"
      }
    }
  ]
}
```

### Codex Worker Spawn Sketch

```text
multi_agent_v1.spawn_agent(agentType="huoshan-worker", input=shard_1, todoId="t2-huoshan-1")
multi_agent_v1.spawn_agent(agentType="huoshan-worker", input=shard_2, todoId="t2-huoshan-2")
multi_agent_v1.spawn_agent(agentType="huoshan-worker", input=shard_3, todoId="t2-huoshan-3")
multi_agent_v1.spawn_agent(agentType="zhipu-worker", input=shard_4, todoId="t2-zhipu-1")
multi_agent_v1.spawn_agent(agentType="zhipu-worker", input=shard_5, todoId="t2-zhipu-2")
multi_agent_v1.spawn_agent(agentType="zhipu-worker", input=shard_6, todoId="t2-zhipu-3")
```

## Example 2: Codex Workers Implement, Claude Reviews

```text
Produce a todoList first.

Dispatch two huoshan-worker Codex workers in parallel for implementation.
Each worker owns a non-overlapping file boundary.

After both finish, dispatch one read-only Claude review task through SCP MCP.
The Claude reviewer depends on both implementation todos and must not edit.

Normalize all worker and review results into UnifiedAgentResult, run final
verification yourself, and make the final accept/revise/hold decision yourself.
```

Expected routing:

| id | goal | kind | runtime | dispatcher | workerType | dependencies | writeStatus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `impl-a` | Implement slice A | implement | codex | codex-worker | huoshan-worker | none | writer |
| `impl-b` | Implement slice B | implement | codex | codex-worker | huoshan-worker | none | writer |
| `review-claude` | Review implementation | review | claude | scp-claude |  | `impl-a`, `impl-b` | read-only |

## Example 3: zhipu fallback

```text
Produce a todoList first.

For this todo, request zhipu. Resolve it to zhipu-worker. If zhipu-worker is
unavailable, fallback to normal-worker. If normal-worker is unavailable, mark
the todo blocked. Do not use Codex default and do not reroute to Claude.

Record the resolved workerType and fallbackApplied in dispatchLedger and in the
normalized result.
```

Resolution outcomes:

```json
[
  {
    "todoId": "gen-bulk",
    "runtime": "codex",
    "dispatcher": "codex-worker",
    "workerType": "zhipu-worker",
    "workerAlias": "zhipu",
    "fallbackApplied": false,
    "status": "dispatched",
    "rawHandle": { "agentId": "ma-010", "agentType": "zhipu-worker" }
  },
  {
    "todoId": "gen-bulk",
    "runtime": "codex",
    "dispatcher": "codex-worker",
    "workerType": "normal-worker",
    "workerAlias": "zhipu",
    "fallbackApplied": true,
    "status": "dispatched",
    "rawHandle": { "agentId": "ma-011", "agentType": "normal-worker" }
  },
  {
    "todoId": "gen-bulk",
    "runtime": "codex",
    "dispatcher": "codex-worker",
    "workerType": null,
    "workerAlias": "zhipu",
    "fallbackApplied": true,
    "status": "blocked",
    "rawHandle": null,
    "reason": "zhipu-worker and normal-worker both unavailable"
  }
]
```

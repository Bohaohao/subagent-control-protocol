---
name: subagent-orchestrator
description: Orchestrate mixed Claude and Codex worker subagents from a single todoList. Use this Skill whenever the user wants Codex to act as controller delegating bounded work — construction/implementation/review/verification, parallel review, parallel verification, parallel repair, multi-agent delegation, non-overlapping implementation across separate files, or structured result summaries with token/cost evidence. The `claude` runtime is dispatched via the subagent-control-protocol MCP server; other delegation names resolve to Codex worker agent types spawned by the Codex host `multi_agent_v1.spawn_agent`.
---

# Subagent Orchestrator Skill

Codex is the **controller**. Bounded work is executed by two kinds of worker, both driven from a single todoList:

- **`claude` runtime** — Claude Code CLI subagents dispatched through the subagent-control-protocol (SCP) MCP server.
- **Codex worker runtime** — non-`claude` delegation names (e.g. `huoshan`, `zhipu`, `huoshan-worker`) that resolve to Codex worker agent types and are spawned by the Codex host `multi_agent_v1.spawn_agent`, **not** by the SCP Node MCP runtime.

This Skill tells you *when* and *how* to delegate to each.

## Runtime keywords and worker alias resolution (hard)

- **`claude` is a reserved runtime keyword.** It is always dispatched via SCP MCP tools (`subagent_run_task`, `subagent_run_many`, `subagent_start`, plus watch/collect as appropriate). Never route `claude` through `multi_agent_v1.spawn_agent`.
- **Non-`claude` delegation names are Codex worker aliases.** They are handled by the Codex host `multi_agent_v1.spawn_agent`, not by the SCP Node MCP runtime.
- **Worker alias resolution order:**
  1. If the user gives a name ending in `-worker` (e.g. `xxx-worker`), query/use that exact agent type.
  2. If the user gives a bare name (e.g. `xxx`), first treat it as an alias and resolve to `xxx-worker` (so `huoshan` → `huoshan-worker`, `zhipu` → `zhipu-worker`).
  3. If the resolved agent type does not exist, try `normal-worker`.
  4. If `normal-worker` also does not exist, mark that branch **blocked** — do not dispatch it. Never fall back to the Codex default agent.

## Hard workflow for construction work (default behavior)

Whenever the user wants subagents to perform **construction / implementation / review / verification** work — even if they only say something like "用 Claude 子 agent 施工这个任务" / "Use Claude subagents to work on this task" — Codex MUST follow this workflow in order. Do not skip steps. These steps apply regardless of whether the implementers are Claude, Codex workers, or mixed.

1. **Create a todoList.** Codex builds a single todoList for the current task before dispatching any worker, Claude or Codex worker.
2. **Specify every todo item fully.** Each todo must include: `goal`, `kind` (plan/implement/review/verify/research/other), `boundary` (owned files or read-only scope), `dependencies` (other todo ids), `writeStatus` (`writer` with an exclusive file set, or `read-only`), `parallelEligible` (boolean), `acceptance`, **plus runtime/dispatcher info**: `runtime` (`claude` or `codex`) and `dispatcher` (`scp-claude` for `claude`, `codex-worker` for Codex workers). Record the requested worker alias and resolved `agentType` for Codex worker todos after alias resolution.
3. **Analyze parallelism.** Codex analyzes which todos can run in parallel and which must be sequential, and records the dependency/parallelism graph. Claude and Codex worker todos may run in parallel with each other as long as file ownership stays non-overlapping.
4. **Dispatch from the todoList.** All dispatch — Claude and Codex worker alike — comes from the same todoList. Route each todo by its `runtime`/`dispatcher`: `claude` → SCP MCP tools; Codex worker → `multi_agent_v1.spawn_agent` with the resolved `agentType`.
5. **Parallelize when eligible.** If two or more todos are parallel-eligible, dispatch them together. For multiple `claude` todos use `subagent_run_many` (set `concurrency` and `dependsOn`). For Codex worker todos, spawn concurrently via `multi_agent_v1.spawn_agent` and track each handle. Mixed parallel batches are allowed.
6. **Mandatory dual review after every construction run — runtime-agnostic.** After implementation, dispatch **two read-only review subagents**: one from a **software-engineering** perspective and one from a **real-user** perspective. This is required whether the implementers were Claude, Codex workers, or mixed. Reviewers should be `claude` runtime by default (richest tool control); a Codex worker may review only if instructed read-only.
7. **Review agents must not edit files.** Both review agents are instructed not to edit anything. Use supported tool controls only: for `claude` set `kind: "review"` and, when the MCP schema allows it, disallow edit tools such as `Edit`, `Write`, and `NotebookEdit`; do not invent an unsupported `permissionMode`. For Codex worker reviewers, instruct read-only behavior in the prompt.
8. **Codex integrates.** Codex integrates implementation + both reviews, decides which review findings to accept, optionally performs targeted fixes (Codex itself, or a bounded implementer subagent with single-writer ownership), then summarizes the integrated result to the user. Codex remains the final integrator.
9. **No unsupported dispatch knobs.** Do not add parameters that are not part of the current MCP tool schema (for `claude`) or the `multi_agent_v1.spawn_agent` schema (for Codex workers).
10. **Timeout means continuation, not controller takeover.** When a delegated branch reaches a timeout terminal state (`timed_out` or equivalent), Codex must first collect whatever progress/results/events/artifacts are available from that worker, turn the unfinished portion into a continuation todo, and dispatch a fresh subagent to continue. Codex must not personally take over just because a subagent timed out. Personal takeover is allowed only when the user explicitly instructs Codex to do the work itself or explicitly stops further delegation.

## User prompt guidance (minimal expected input)

The user only needs to say something like:
- "用 Claude 子 agent 施工这个任务"
- "Use Claude subagents to work on this task"
- "用 huoshan/zhipu worker 施工这个任务" / "Use huoshan workers to work on this task"

Codex MUST infer decomposition, the todoList, runtime assignment, and parallelism from that — the user is not expected to spell out the plan. If a directive goal is missing, ask once; otherwise proceed. If the user names a non-`claude` runtime, apply worker alias resolution before dispatch.

## Layers (keep them distinct)

- **MCP layer (tool/process):** `subagent_run_task`, `subagent_run_many`, `subagent_start`, `subagent_collect`, `subagent_status`, `subagent_watch`, `subagent_cleanup`, `subagent_cancel`. These manage Claude CLI processes, concurrency, logging, heartbeat health, artifact cleanup, and structured output. They serve the `claude` runtime only.
- **Codex host layer:** `multi_agent_v1.spawn_agent`, `wait_agent`, `send_input`. These spawn and collect Codex worker agents. They serve non-`claude` runtimes only and are not part of the SCP Node MCP runtime.
- **Skill layer (workflow/orchestration):** this file. It governs task decomposition, ownership, runtime selection, verification, and how you decide between one-task vs. many-task delegation.

Use the MCP tools or the Codex host tools to *execute*; use this Skill to *decide* which.

### Desktop status boundary

SCP is the status source; any desktop monitor app is a **read-only observer**.
The desktop project is separate from this repo and is not part of the plugin
bundle. The desktop may watch runs through `subagent_desktop_status`, an
optional stable `status.json` mirror, or the opt-in read-only localhost bridge
started with `subagent_status_bridge`. The desktop view model is defined by
`schemas/desktop-status.schema.json` and versioned by its top-level `schema`
field (`scp.run-view/v1`); a widget reads `bridge.json`
(`scp.bridge-discovery/v1`, written on bridge start, removed on stop) to find
the bridge's `host`/`port`. The bridge is loopback-only by default; non-loopback
hosts require explicit `allowNonLoopback: true` because the bridge has no
authentication. The desktop never dispatches, cancels, or writes run state.
Dispatch and cancellation stay on the MCP/tool layer
(`subagent_run_*`, `subagent_cancel`); the controller (Codex) stays the only
decision-maker. A stale or missing heartbeat shown by the desktop means
"unknown / possibly stalled" - it is a signal to surface, not a trigger to kill a
process.

## dispatchLedger

Track every dispatched worker in a dispatchLedger keyed by todo id. Handle shapes differ by runtime — never confuse them:

- **Claude handles** (from SCP MCP): `runId`, `runDir`, `taskId`.
- **Codex worker handles** (from `multi_agent_v1.spawn_agent`): `agentId`, `agentType`, `nickname`.

Use the `runtime` field on the todo to decide which collect/wait path applies: `subagent_collect`/`subagent_watch` for Claude handles, `wait_agent`/`send_input` for Codex worker handles.

## Result normalization

Normalize every worker's result into the agent-result shape before integration. Sources differ by runtime:

- **Claude results** come from the SCP MCP `runSummary`/`results` plus `measuredUsageSummary`/`usage`. These are the source of truth for token/cost.
- **Codex worker results** come from the `wait_agent` final message. Codex worker prompts **must** ask for JSON compatible with the agent-result fields (`status`, `summary`, `filesChanged`, `commandsRun`, `verification`, `risks`, `nextSteps`, `tokenUsageSummary`) **plus** `workerRuntime: "codex"`, `workerType` (the resolved `agentType`), optional `workerAlias`, and optional `fallbackApplied`.
  - If the final message is not structured JSON, the controller may call `send_input` **once** to ask the worker to emit a valid completion object.
  - If it is still invalid, integrate the output as a partial result with `plainTextResult` set and `normalizationFailed: true`; do not discard the work, and flag it in the final summary.

## Codex worker 429 rate-limit auto-continue

A terminal rate-limit recovery rule for Codex workers only:

- **Scope:** Applies only to Codex worker todos (`runtime: codex`, `dispatcher: codex-worker`). Never apply this to the `claude` runtime.
- **Trigger:** Only when the `wait_agent` **final** status / final message clearly indicates a 429 rate limit — match signals such as `429`, `rate limit` / `rate_limit`, `too many requests`, or `限流`. Detection is **terminal/final-message based**: do not claim to detect mid-run or intermediate-message 429s. If the final message is ambiguous, do not auto-continue.
- **Action:** The controller sends exactly `继续` to that worker via `send_input`, then calls `wait_agent` again.
- **Budget:** Maximum **3** auto-continue attempts per worker. After the third attempt, accept the worker's last reply as final.
- **Separate from JSON-result repair:** This 429 retry budget is independent of the one-time `send_input` follow-up used to repair a non-JSON final message (see Result normalization). Each has its own counter; using one does not consume the other.
- **On exhaustion / failure:** If recovery does not succeed within the budget, integrate the result as partial/blocked and flag it in the final summary.
- **Reporting:** Note in the final summary whether 429 auto-continue was used, how many attempts were made, and whether recovery succeeded.

## Decision rules

- **Claude runtime → SCP MCP tools.** One bounded task → `subagent_run_task`; multiple tasks, dependency chains, or parallel review/verification → `subagent_run_many` (set `concurrency`, use `dependsOn`); long-running parallel work → `subagent_start` + `subagent_watch` + `subagent_collect`.
- **Codex worker runtime → `multi_agent_v1.spawn_agent`.** Spawn with the resolved `agentType` (after alias resolution), then `wait_agent`/`send_input` to collect. Do not route Codex workers through SCP MCP, and do not route `claude` through `multi_agent_v1.spawn_agent`.
- **Codex worker 429 rate-limit → auto-continue (Codex workers only).** If a Codex worker's `wait_agent` **terminal** final status/message clearly indicates 429/rate limit/too many requests/限流, send exactly `继续` via `send_input` and wait again, up to **3** attempts per worker. This budget is separate from the one-time JSON-result repair follow-up. Final-message/terminal based only — no mid-run or intermediate-message 429 detection.
- **Decomposition or wiring check → `dryRun: true`** (Claude path). Validate task plan shape and MCP wiring before spending a real run.
- **Review / research / verification agents → read-only behavior.** Instruct them not to edit files, use `kind: "review"`/`"verify"`/`"research"` (Claude) and disallow edit tools when available. Do not use unsupported schema fields.
- **Implementation agents → non-overlapping file ownership.** Assign each implementer a disjoint set of files. Single-writer per file. Never let two workers — Claude or Codex worker — edit the same file concurrently.
- **Codex stays the final integrator.** Subagents implement pieces; Codex merges, validates, and ships. Never let a subagent make the final merge/release decision.

## Timeout recovery and re-dispatch

- If a Claude or Codex worker branch times out, collect the best available progress snapshot first (`subagent_collect` / `subagent_status` / `subagent_watch` for Claude; `wait_agent` terminal output plus any prior structured result for Codex workers).
- Update the todoList with a continuation todo that records what is already done, what remains, and what evidence/progress is being carried forward.
- Dispatch a fresh subagent to continue from that recovered context.
- Timeout alone is **not** a reason for Codex to personally take over.

## Result contract (require this from every worker)

Every worker — Claude or Codex worker — must return JSON matching `schemas/agent-result.schema.json`, including:

- `status`, `summary`, `filesChanged`, `commandsRun`, `verification`, `risks`, `nextSteps`
- **`tokenUsageSummary`** — required, always. A worker-authored note on whether exact token usage was visible; never fabricate exact counts.
- `metrics` — optional token/cost numbers when visible.
- For Codex workers only: also include `workerRuntime: "codex"` and `workerType` (see Result normalization). Include `workerAlias` and `fallbackApplied` when alias resolution or fallback happened.

## Token & cost evidence

Prefer measured numbers over a worker's self-report:

- For `claude`, use `measuredUsageSummary` / `usage` from the Claude CLI envelope captured by the SCP MCP server as the source of truth for actual token/cost.
- For Codex workers, token/cost may not be separately measured; cite `wait_agent` final message figures as worker-reported and label them as such.
- Use the worker's `tokenUsageSummary` only as qualitative context — a worker may not see exact usage while composing its result.

## Final summary (Codex produces this)

After a run, summarize for the user:

- number of workers invoked, their roles, and their runtimes (Claude vs Codex worker / agentType)
- max concurrency used
- per-worker outputs and overall status, noting any `normalizationFailed`/partial results
- whether Codex worker 429 auto-continue was used (attempt count) and whether recovery succeeded
- whether any timeout recovery / continuation re-dispatch happened, and what prior progress was carried forward
- verification performed and evidence
- risks, with severity
- token/cost evidence (citing `measuredUsageSummary`/`usage` for Claude; worker-reported for Codex workers)

## Safety

- Parallelize read-only work (review, research, verification) first.
- Keep implementation single-writer with explicit, non-overlapping file ownership across both runtimes.
- Reserve `permissionMode: "bypassPermissions"`/`"auto"` for isolated workspaces; never for shared trees.
- Never delegate merge, release, or push decisions to a subagent.
- Never fall back to the Codex default agent when a Codex worker agent type is missing — mark the branch blocked instead.

---
name: subagent-orchestrator
description: Orchestrate Claude subagents via the subagent-control-protocol MCP server. Use this Skill whenever the user wants Codex to act as controller delegating bounded work to Claude Code CLI subagents — construction/implementation/review/verification work, parallel review, parallel verification, parallel repair, multi-agent delegation, non-overlapping implementation across separate files, or producing structured result summaries with token/cost evidence.
---

# Subagent Orchestrator Skill

Codex is the **controller**. Claude Code CLI subagents execute bounded work. This Skill tells you *when* and *how* to delegate.

## Hard workflow for construction work (default behavior)

Whenever the user wants Claude subagents to perform **construction / implementation / review / verification** work — even if they only say something like "用 Claude 子 agent 施工这个任务" / "Use Claude subagents to work on this task" — Codex MUST follow this workflow in order. Do not skip steps.

1. **Create a todoList.** Codex builds a todoList for the current task before dispatching any subagent.
2. **Specify every todo item fully.** Each todo must include: `goal`, `kind` (plan/implement/review/verify/research/other), `boundary` (owned files or read-only scope), `dependencies` (other todo ids), `writeStatus` (`writer` with an exclusive file set, or `read-only`), `parallelEligible` (boolean), and `acceptance`.
3. **Analyze parallelism.** Codex analyzes which todos can run in parallel and which must be sequential, and records the dependency/parallelism graph.
4. **Dispatch from the todoList.** Use the todoList as the basis for all subagent task dispatch.
5. **Parallelize when eligible.** If two or more todos are parallel-eligible, dispatch them together via `subagent_run_many` (set `concurrency` and `dependsOn` accordingly) rather than sequentially.
6. **Mandatory dual review after every construction run.** After implementation, dispatch **two read-only review Claude subagents**: one from a **software-engineering** perspective and one from a **real-user** perspective.
7. **Review agents must not edit files.** Both review agents run read-only (`permissionMode` read-only) and are instructed not to edit anything.
8. **Codex integrates.** Codex integrates implementation + both reviews, decides which review findings to accept, optionally performs targeted fixes (Codex itself, or a bounded implementer subagent with single-writer ownership), then summarizes the integrated result to the user.
9. **No unsupported dispatch knobs.** Do not add parameters that are not part of the current MCP tool schema.

## User prompt guidance (minimal expected input)

The user only needs to say something like:
- "用 Claude 子 agent 施工这个任务"
- "Use Claude subagents to work on this task"

Codex MUST infer decomposition, the todoList, and parallelism from that — the user is not expected to spell out the plan. If a directive goal is missing, ask once; otherwise proceed.

## Layers (keep them distinct)

- **MCP layer (tool/process):** `subagent_run_task`, `subagent_run_many`, `subagent_status`, `subagent_cancel`. These manage processes, concurrency, logging, and structured output.
- **Skill layer (workflow/orchestration):** this file. It governs task decomposition, ownership, verification, and how you decide between one-task vs. many-task delegation.

Use the MCP tools to *execute*; use this Skill to *decide*.

## Decision rules

- **One bounded task → `subagent_run_task`.** A single review, implementation, research, or verification job.
- **Multiple tasks, dependency chains, or parallel review/verification → `subagent_run_many`.** Set `concurrency` to bound parallelism; use `dependsOn` for ordering.
- **Decomposition or wiring check → `dryRun: true`.** Validate task plan shape and MCP wiring before spending a real run.
- **Review / research / verification agents → read-only.** Set `permissionMode` accordingly and instruct them not to edit files.
- **Implementation agents → non-overlapping file ownership.** Assign each implementer a disjoint set of files. Single-writer per file. Never let two subagents edit the same file concurrently.
- **Codex stays the final integrator.** Subagents implement pieces; Codex merges, validates, and ships. Never let a subagent make the final merge/release decision.

## Result contract (require this from every subagent)

Every Claude subagent must return JSON matching `schemas/agent-result.schema.json`, including:

- `status`, `summary`, `filesChanged`, `commandsRun`, `verification`, `risks`, `nextSteps`
- **`tokenUsageSummary`** — required, always. A Claude-authored note on whether exact token usage was visible; never fabricate exact counts.
- `metrics` — optional token/cost numbers when visible.

## Token & cost evidence

Prefer the MCP-measured numbers over the subagent's self-report:

- Use `measuredUsageSummary` / `usage` from the Claude CLI envelope captured by the MCP server as the source of truth for actual token/cost.
- Use the subagent's `tokenUsageSummary` only as qualitative context — Claude may not see exact usage while composing its result.

## Final summary (Codex produces this)

After a run, summarize for the user:

- number of agents invoked and their roles
- max concurrency used
- per-agent outputs and overall status
- verification performed and evidence
- risks, with severity
- token/cost evidence (citing `measuredUsageSummary`/`usage`)

## Safety

- Parallelize read-only work (review, research, verification) first.
- Keep implementation single-writer with explicit, non-overlapping file ownership.
- Reserve `permissionMode: "bypassPermissions"`/`"auto"` for isolated workspaces; never for shared trees.
- Never delegate merge, release, or push decisions to a subagent.

# Subagent protocol

This kit treats Codex as the controller and Claude Code CLI as a bounded
subagent executor. Each subagent task must return the same JSON shape, so the
controller can merge results without reading free-form prose.

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

The controller wraps each task with measured process metadata. Top-level task
status may also be `skipped`, `timed_out`, or `cancelled`. When the Claude CLI
reports measured usage, the controller records `usage` plus
`measuredUsageSummary` alongside Claude's own `tokenUsageSummary`.

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

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
- `metrics`: optional token/cost fields when available

## Recommended task split

- Phase A: parallel planning or analysis
- Phase B: single writer implements shared code
- Phase C: parallel review and verification
- Phase D: controller applies small fixes, runs final checks, reports evidence

This reduces conflict while still using parallelism where it is useful.

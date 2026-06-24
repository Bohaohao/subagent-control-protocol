# todoList-Orchestrated Construction (Codex Remains Controller)

> Advanced controller reference: most users should use the minimal prompts in
> the README. This file documents the controller-side workflow that Codex
> follows after it infers Claude subagent construction intent.

> Orchestration pattern: Codex is the **controller**. Before dispatching
> anything, Codex produces a **`todoList`** — one entry per unit of work, each
> recording goal / kind / boundary / dependencies / write status / parallel
> eligibility / acceptance. The dispatch plan is derived directly from that
> `todoList`. After the implementers finish, Codex **adds two
> read-only review agents** — a software-engineering review and a real-user
> review — then integrates everything and decides whether to ship.

## When to use this prompt

- A change has more than one part and you want a disciplined, auditable plan
  before any subagent runs.
- You want parallelism where it is safe (independent, non-overlapping slices)
  and strict sequencing where it is not (shared files).
- You want built-in, mandatory review from two independent perspectives
  (engineering correctness and real-user realism) before the controller ships.

## Hard rules

- **No dispatch without a `todoList`.** The controller writes the `todoList`
  first; the dispatch plan is generated from it.
- **Every todo records the seven fields.** `goal`, `kind`, `boundary`,
  `dependencies`, `writeStatus`, `parallelEligible`, `acceptance`.
- **Single-writer per file.** A writer todo lists its exclusive file set; two
  writers never own the same file. Overlapping writers are merged or sequenced
  via `dependsOn`.
- **Two read-only reviews are mandatory after implementation.** Whenever any
  todo is a writer, the controller appends:
  - `review-eng` — software-engineering review (correctness, contracts, tests,
    regressions)
  - `review-user` — real-user review (does it serve the intended user workflow;
    UX/integration realism)
  Both are `kind: review`, `writeStatus: read-only`, `parallelEligible: true`,
  and depend on the implementers. They never edit files.
  This is a controller-side rule enforced by the orchestrator Skill. The MCP
  server executes the tasks it is given; it does not inject reviewers by itself.
- **Codex stays the integrator.** Subagents implement or review pieces; Codex
  merges, runs final verification, folds the reviews into one decision, applies
  small fixes, and ships. A subagent never merges, releases, or declares done.

## Minimal controller prompt (give this to Codex)

```
You are the controller. Produce a todoList BEFORE dispatching any task, then
derive the dispatch plan from it. Do not improvise tasks after the fact.

For each todo record: goal (one sentence), kind
(plan|implement|review|verify|research|other), boundary (owned files or
read-only), dependencies (other todo ids), writeStatus (writer|read-only plus
the exclusive file set for writers), parallelEligible (true|false), and
acceptance (the concrete checkable criterion that marks it done).

Rules:
- Single-writer per file. Two writers never own the same file; merge or sequence
  overlapping writers with dependsOn.
- Writers run with tools/permissionMode that allow edits to their owned set
  only; read-only todos run with no write capability.
- Independent, non-overlapping todos are dispatched in parallel up to
  concurrency.

After implementation, AUTOMATICALLY append two read-only review todos that
depend on the implementers:
- review-eng (software-engineering review): correctness, contracts, tests,
  regressions. Read only. Do not edit.
- review-user (real-user review): does the change serve the intended real user
  workflow; UX/integration realism. Read only. Do not edit.

Then integrate:
1. Read run-summary.json and each tasks/<id>/result.json.
2. Cross-check filesChanged across writer results for non-overlap; flag any
   collision as a contract violation.
3. Fold the two reviews plus verifier evidence into one accept/revise/hold
   decision.
4. If a fix is needed, apply it yourself (single writer) or dispatch one
   targeted fix to the owning agent — never let two agents fix the same file.
5. Run the full verification (npm run check, tests, smoke) and make the final
   ship/hold decision yourself.

Cite measuredUsageSummary/usage for token-cost evidence.
```

## Controller's expected internal `todoList`

For a change that splits into two implementation slices plus the mandatory
reviews, the controller produces something like this (adapt the goals, files,
and acceptance to the real change):

| id | goal | kind | boundary | dependencies | writeStatus | parallelEligible | acceptance |
|----|------|------|----------|--------------|-------------|------------------|------------|
| `impl-core` | Implement the core behavior | implement | owns `src/core/scheduler.mjs`, `src/core/result-normalizer.mjs` | — | writer (those files only) | true | `node --check` passes; result JSON returned |
| `impl-scripts` | Implement the CLI/script wiring | implement | owns `scripts/run-claude-agents.mjs` | — | writer (that file only) | true | `node --check` passes; result JSON returned |
| `review-eng` | Software-engineering review | review | read-only, whole tree | `impl-core`, `impl-scripts` | read-only | true | structured findings returned; no edits |
| `review-user` | Real-user review | review | read-only, whole tree | `impl-core`, `impl-scripts` | read-only | true | structured findings returned; no edits |

Notes on this split:
- `impl-core` and `impl-scripts` are `parallelEligible: true` because their
  owned file sets are disjoint — they run in one `subagent_run_many` batch with
  `concurrency: 2`.
- `review-eng` and `review-user` `dependsOn` both implementers, so they run in a
  second batch after implementation, in parallel with each other
  (`concurrency: 2`).
- Optional verifier todos (type-check, tests, smoke) may be added to the second
  batch as additional `kind: verify` read-only todos.

## Concrete task plan (copy/adapt)

This is the dispatch plan the controller derives from the `todoList` above.
Implementation batch first; review batch depends on it.

```json
{
  "version": 1,
  "workspace": "../..",
  "outputDir": "../../.subagent-runs",
  "concurrency": 2,
  "defaults": {
    "effort": "low",
    "timeoutMs": 300000,
    "permissionMode": "default",
    "tools": []
  },
  "tasks": [
    {
      "id": "impl-core",
      "title": "Implement core slice",
      "kind": "implement",
      "prompt": "Implement the change in src/core/scheduler.mjs and src/core/result-normalizer.mjs ONLY. Do not edit any other file. Run `node --check` on changed files. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "impl-scripts",
      "title": "Implement scripts slice",
      "kind": "implement",
      "prompt": "Implement the change in scripts/run-claude-agents.mjs ONLY. Do not edit any other file. Run `node --check` on it. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "review-eng",
      "title": "Software-engineering review",
      "kind": "review",
      "dependsOn": ["impl-core", "impl-scripts"],
      "prompt": "Review the implementation for correctness, contract changes, test coverage, and regressions. Read only. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "review-user",
      "title": "Real-user review",
      "kind": "review",
      "dependsOn": ["impl-core", "impl-scripts"],
      "prompt": "Review whether the change serves the intended real-user workflow and integrates realistically (UX, edge cases a real user would hit). Read only. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    }
  ]
}
```

## Orchestration boundaries (for the AI controller)

- **Codex = controller**: writes the `todoList`, derives the dispatch plan,
  assigns file ownership, auto-appends the two read-only reviews, detects
  overlap, integrates, verifies, ships.
- **Each Claude subagent = bounded worker**: an implementer edits ONLY its owned
  files; a reviewer edits nothing. Every worker returns structured JSON, never
  edits outside its boundary, never decides to merge or release.
- **todoList is the source of truth**: dispatch mirrors it; if a task is not in
  the `todoList`, it is not dispatched.
- **Two reviews are mandatory**: implementation todos always trigger
  `review-eng` and `review-user` as dependents; both are read-only and parallel.
- **Integration is the controller's job**: the full build/test/smoke run and the
  accept/revise/hold synthesis happen after all workers finish, run by Codex.
- **Fixes stay single-writer**: if integration breaks, route the fix to the one
  owner (Codex itself or the single owning agent) — never two agents on one file.
- **Result contract**: every subagent returns JSON matching
  `schemas/agent-result.schema.json`, including `filesChanged` (so the
  controller can verify non-overlap) and `tokenUsageSummary`.

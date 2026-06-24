# Non-Overlapping Implementation (Codex Remains Controller)

> Orchestration pattern: Codex is the **controller**. Multiple Claude Code CLI
> subagents implement **disjoint, non-overlapping** parts of a change in
> parallel. Each subagent owns an exclusive set of files. **No two subagents
> edit the same file.** Codex integrates, validates, and ships.

## When to use this prompt

- A change naturally splits into independent file sets
  (e.g. one agent owns `src/core/`, another owns `scripts/`, another owns
  `examples/`).
- You can assign **single-writer, non-overlapping** file ownership per agent.
- You want parallel implementation without merge conflicts.

## Hard rules

- **Single-writer per file.** Every file is owned by exactly one implementer.
  List each agent's owned files explicitly in its prompt.
- **No shared edits.** If two agents would touch the same file, merge them
  into one agent, or sequence them with `dependsOn`.
- **Codex stays the integrator.** Subagents implement pieces; Codex merges,
  runs verification, and decides to ship. A subagent never makes the final
  merge/release decision.
- **Bounded parallelism.** Set `concurrency` to match the number of
  independent implementers.

## Controller prompt (give this to Codex)

```
You are the controller. Decompose the change into non-overlapping
implementation slices and dispatch them in parallel via subagent_run_many.
Each subagent gets an EXCLUSIVE file set — no two subagents may edit the same
file. State each subagent's owned files in its prompt and forbid edits outside
that set.

Example split (adapt to the real change):

- Task "impl-core":
    kind: implement
    owns: src/core/scheduler.mjs, src/core/result-normalizer.mjs
    prompt: "Implement <change> in src/core/scheduler.mjs and
             src/core/result-normalizer.mjs ONLY. Do not edit any other file.
             Run `node --check` on the files you changed. Return JSON matching
             schemas/agent-result.schema.json."

- Task "impl-scripts":
    kind: implement
    owns: scripts/run-claude-agents.mjs
    prompt: "Implement <change> in scripts/run-claude-agents.mjs ONLY. Do not
             edit any other file. Run `node --check` on it. Return JSON
             matching schemas/agent-result.schema.json."

- Task "impl-examples":
    kind: implement
    owns: examples/plans/*.json
    prompt: "Update example plans under examples/plans/ ONLY. Do not edit any
             other file. Validate each file is valid JSON. Return JSON matching
             schemas/agent-result.schema.json."

Set concurrency to 3 (one per implementer). Do not set dependsOn between
implementers — they are independent because their file sets are disjoint.

After the run:
1. Read run-summary.json and each tasks/<id>/result.json.
2. Confirm no two agents reported changing the same file (check filesChanged
   across results; flag any overlap as a contract violation).
3. Integrate: run the full `npm run check`, tests, and `npm run smoke:mcp`.
4. If integration fails, dispatch a single targeted fix to the owning agent
   of the failing file — never let two agents fix the same file at once.
5. You (Codex) make the final ship/hold decision.

Cite measuredUsageSummary/usage for token-cost evidence.
```

## Orchestration boundaries (for the AI controller)

- **Codex = controller**: assigns file ownership, dispatches implementers,
  detects overlap, integrates, verifies, ships.
- **Each Claude subagent = bounded implementer**: edits ONLY its owned files,
  runs a local syntax check, returns structured JSON, never edits outside its
  set, never decides to merge or release.
- **Non-overlap is enforced by prompt + verification**: state owned files in
  each prompt, then cross-check `filesChanged` across results for collisions.
- **Integration is the controller's job**: the full build/test/smoke run
  happens after all implementers finish, run by Codex (or by a single
  verifier subagent — see parallel-verification.md).
- **Fixes stay single-writer**: if integration breaks, route the fix to the
  one agent that owns the failing file.
- **Result contract**: every subagent returns JSON matching
  `schemas/agent-result.schema.json`, including `filesChanged` (so the
  controller can verify non-overlap) and `tokenUsageSummary`.

## Concrete task plan (copy/adapt)

```json
{
  "version": 1,
  "workspace": "../..",
  "outputDir": "../../.subagent-runs",
  "concurrency": 3,
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
      "id": "impl-examples",
      "title": "Update examples slice",
      "kind": "implement",
      "prompt": "Update example plans under examples/plans/ ONLY. Do not edit any other file. Validate each is valid JSON. Return JSON matching schemas/agent-result.schema.json."
    }
  ]
}
```

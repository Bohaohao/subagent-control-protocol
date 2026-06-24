# Parallel Verification with Multiple Claude Subagents

> Orchestration pattern: Codex is the **controller**. After implementation,
> Codex dispatches **parallel verifiers** — each checking one independent
> acceptance criterion. Verifiers are read-only. Codex aggregates pass/fail
> evidence and decides whether the work is done.

## When to use this prompt

- Implementation is complete (by Codex or by a prior implementation subagent).
- You have multiple independent acceptance criteria
  (type-check, tests, lint, MCP smoke, schema validation).
- You want each criterion checked in parallel with structured evidence.

## Controller prompt (give this to Codex)

```
You are the controller. The implementation is done. Now verify it in parallel
using subagent_run_many with concurrency equal to the number of checks.
Every verifier is read-only: permissionMode must not allow writes, and each
verifier must not edit files.

Plan (independent verifiers, no dependsOn between them):

- Task "verify-types":
    kind: verify
    prompt: "Run `npm run check` (or the project's type/syntax check). Report
             pass/fail with the exact failing output. Do not edit files. Return
             JSON matching schemas/agent-result.schema.json with verification
             evidence."

- Task "verify-tests":
    kind: verify
    prompt: "Run the project test suite. Report pass/fail, counts, and any
             failing test names. Do not edit files. Return JSON matching
             schemas/agent-result.schema.json with verification evidence."

- Task "verify-mcp":
    kind: verify
    prompt: "Run `npm run smoke:mcp`. Confirm the MCP server starts and exposes
             its tools. Do not edit files. Return JSON matching
             schemas/agent-result.schema.json with verification evidence."

- Task "verify-schemas":
    kind: verify
    prompt: "Validate that example task plans and agent results conform to
             schemas/*.json. Report any schema violations. Do not edit files.
             Return JSON matching schemas/agent-result.schema.json."

After the run:
1. Read run-summary.json for overall status.
2. Read each tasks/<id>/result.json; collect each verifier's status and
   evidence into one verification matrix (check x pass/fail x evidence).
3. If any verifier fails, do not declare done. Decide: request a fix from a
   single-writer implementation subagent, or fix it yourself.
4. You (Codex) make the final "done / not done" decision. A subagent never
   declares the work complete on your behalf.

Cite measuredUsageSummary/usage for token-cost evidence.
```

## Orchestration boundaries (for the AI controller)

- **Codex = controller**: defines acceptance criteria, dispatches verifiers,
  aggregates evidence, owns the done/not-done decision.
- **Each Claude subagent = bounded verifier**: runs one check, read-only,
  returns structured JSON with evidence, never edits, never declares done.
- **Parallelism**: verifiers are independent — no `dependsOn` between them.
- **No writes**: verification must not mutate the tree. If a verifier would
  need to write, that is implementation work, not verification — reclassify it.
- **Aggregation**: the controller, not a subagent, rolls up the matrix.
- **Result contract**: every subagent returns JSON matching
  `schemas/agent-result.schema.json`, including `tokenUsageSummary` and
  `verification[]` with concrete evidence.

## Concrete task plan (copy/adapt)

```json
{
  "version": 1,
  "workspace": "../..",
  "outputDir": "../../.subagent-runs",
  "concurrency": 4,
  "defaults": {
    "effort": "low",
    "timeoutMs": 300000,
    "permissionMode": "default",
    "tools": []
  },
  "tasks": [
    {
      "id": "verify-types",
      "title": "Type/syntax check",
      "kind": "verify",
      "prompt": "Run `npm run check`. Report pass/fail with exact output. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "verify-tests",
      "title": "Test suite",
      "kind": "verify",
      "prompt": "Run the project tests. Report pass/fail and failing names. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "verify-mcp",
      "title": "MCP smoke",
      "kind": "verify",
      "prompt": "Run `npm run smoke:mcp`. Confirm tools are exposed. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "verify-schemas",
      "title": "Schema conformance",
      "kind": "verify",
      "prompt": "Validate example plans/results against schemas/*.json. Report violations. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    }
  ]
}
```

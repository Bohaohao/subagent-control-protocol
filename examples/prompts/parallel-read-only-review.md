# Parallel Read-Only Review with Multiple Claude Subagents

> Orchestration pattern: Codex is the **controller**. Multiple Claude Code CLI
> subagents run **in parallel** as read-only reviewers. No subagent edits files.
> Codex collects their structured results and synthesizes the final decision.

## When to use this prompt

- You want several independent perspectives on the same change set
  (e.g. security review, API/regression review, test-coverage review).
- The reviewers do not depend on each other and touch no files.
- You want bounded parallelism instead of one long sequential review.

## Controller prompt (give this to Codex)

```
You are the controller. Delegate a parallel, read-only code review to Claude
subagents via the subagent-control-protocol MCP server. Do NOT edit files
yourself unless a reviewer flags a critical blocker you must confirm.

Plan (use subagent_run_many with concurrency 3, permissionMode "default"):

- Task "review-security":
    kind: review
    prompt: "Review the diff for secrets, unsafe deserialization, injection,
             and privilege issues. Read only. Do not edit files. Return JSON
             matching schemas/agent-result.schema.json."

- Task "review-api":
    kind: review
    prompt: "Review the public API surface for breaking changes, naming, and
             contract regressions. Read only. Do not edit files. Return JSON
             matching schemas/agent-result.schema.json."

- Task "review-tests":
    kind: review
    prompt: "Review test coverage for the changed code. List missing high-value
             tests. Read only. Do not edit files. Return JSON matching
             schemas/agent-result.schema.json."

Each reviewer is independent and read-only: set permissionMode so they cannot
write, and instruct them not to edit files. Do not set dependsOn between
reviewers — they run in parallel.

After the run:
1. Read run-summary.json for overall status.
2. Read tasks/<id>/result.json for each reviewer's structured findings.
3. Synthesize a single review report: cross-cutting issues, per-reviewer
   findings, severity, and recommended next steps.
4. You (Codex) make the final accept/reject/revise decision. Never let a
   subagent make the merge or ship decision.

Return your synthesized report and cite measuredUsageSummary/usage for
token-cost evidence.
```

## Orchestration boundaries (for the AI controller)

- **Codex = controller**: decomposes, dispatches, reads results, decides.
- **Each Claude subagent = bounded reviewer**: read-only, returns structured
  JSON, never edits, never decides to merge.
- **Parallelism**: reviewers run concurrently up to `concurrency`; no
  `dependsOn` edges between them.
- **Single-writer rule does not apply** here because nobody writes — but the
  read-only constraint is mandatory.
- **Result contract**: every subagent must return JSON matching
  `schemas/agent-result.schema.json`, including `tokenUsageSummary`.

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
      "id": "review-security",
      "title": "Security review",
      "kind": "review",
      "prompt": "Review the diff for security issues. Read only. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "review-api",
      "title": "API regression review",
      "kind": "review",
      "prompt": "Review the public API for breaking changes. Read only. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    },
    {
      "id": "review-tests",
      "title": "Test coverage review",
      "kind": "review",
      "prompt": "Review test coverage for the changed code. Read only. Do not edit files. Return JSON matching schemas/agent-result.schema.json."
    }
  ]
}
```

To dry-run this shape, save the JSON above as a temporary plan file and run:

```powershell
node .\scripts\run-claude-agents.mjs --plan .\path\to\parallel-read-only-review.plan.json --dry-run
```

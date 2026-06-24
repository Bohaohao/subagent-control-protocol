# Subagent Control Protocol

**Subagent Control Protocol (SCP)** is an installable MCP server that lets Codex act as the controller and delegate bounded work to Claude Code CLI subagents.

**Subagent Control Protocol（SCP）** 是一个可直接安装和配置的 MCP Server。它让 Codex 作为总控，把明确边界的任务分派给 Claude Code CLI 子 agent，并把执行结果以结构化形式收回。

## What It Does

SCP turns `claude -p` calls into controller-readable task runs:

- run one Claude subagent task;
- run many dependency-aware tasks with bounded concurrency;
- capture prompts, stdout, stderr, raw Claude JSON, normalized results, and run summaries;
- kill timed-out Windows or Unix process trees;
- expose status and best-effort cancellation through MCP tools;
- keep generated run artifacts out of git.

SCP 的目标不是替代 Codex，而是补齐“总控调用子 agent”这条链路：

- Codex 决定任务拆分和验收标准；
- Claude Code CLI 作为子 agent 执行局部任务；
- MCP Server 负责进程、并发、日志、结构化输出和结果归档；
- Codex 读取 `run-summary.json` 与 MCP `structuredContent`，再决定下一步。

## Install

Requirements:

- Node.js 20+
- Claude Code CLI installed and authenticated
- A Codex or MCP-capable client

Clone and install:

```powershell
git clone https://github.com/Bohaohao/subagent-control-protocol.git
cd subagent-control-protocol
npm install
npm run check
npm run smoke:mcp
```

Run as a local MCP server:

```powershell
npm start
```

Or through the package bin:

```powershell
npx subagent-control-protocol
```

## MCP Configuration

Example MCP config:

```json
{
  "mcpServers": {
    "subagent-control-protocol": {
      "command": "node",
      "args": ["D:/private/agent-orchestration-kit/src/server.mjs"],
      "env": {
        "CLAUDE_BIN": "claude"
      }
    }
  }
}
```

If installed globally or from a package path, use the bin:

```json
{
  "mcpServers": {
    "subagent-control-protocol": {
      "command": "subagent-control-protocol",
      "args": []
    }
  }
}
```

如果 Claude 在 Windows 上通过 `claude.cmd` 启动，SCP 会尝试解析背后的真实 `claude.exe`，避免子进程和参数转义问题。也可以显式设置 `CLAUDE_BIN`。

## MCP Tools

`subagent_run_task`

Run one Claude Code subagent task and return a normalized result. Use this for a single review, implementation, research, or verification job.

`subagent_run_many`

Run multiple tasks with dependency control and bounded parallelism. Use this when the controller wants several read-only reviewers or verifiers to work in parallel.

`subagent_status`

Read one `run-summary.json`, or list recent run summaries from an output directory. This is how a controller can inspect prior runs without scraping terminal output.

`subagent_cancel`

Best-effort cancellation for active Claude child processes in the current MCP server process.

## Task Plan Example

```json
{
  "version": 1,
  "workspace": "../my-project",
  "outputDir": "../.subagent-runs",
  "concurrency": 2,
  "defaults": {
    "model": "sonnet",
    "effort": "low",
    "timeoutMs": 300000,
    "permissionMode": "default",
    "tools": []
  },
  "tasks": [
    {
      "id": "review-api",
      "title": "Review API changes",
      "kind": "review",
      "prompt": "Review the API layer for regressions. Do not edit files."
    },
    {
      "id": "review-tests",
      "title": "Review tests",
      "kind": "review",
      "prompt": "Review test coverage and identify missing high-value tests. Do not edit files."
    },
    {
      "id": "summarize",
      "title": "Summarize findings",
      "kind": "verify",
      "dependsOn": ["review-api", "review-tests"],
      "prompt": "Summarize the completed review outputs as structured JSON."
    }
  ]
}
```

Run the same core through CLI:

```powershell
node .\scripts\run-claude-agents.mjs --plan .\examples\plans\review-and-summarize.plan.json --concurrency 2 --dry-run
```

## Result Contract

Every Claude subagent is asked to return JSON matching `schemas/agent-result.schema.json`:

- `status`: `completed`, `partial`, `blocked`, or `failed`
- `summary`: factual outcome
- `filesChanged`: files changed and why
- `commandsRun`: commands with pass/fail/skipped state
- `verification`: checks and evidence
- `risks`: remaining risks
- `nextSteps`: concrete follow-up actions
- `metrics`: optional token and cost metrics

The runner also normalizes common variants such as `files_changed`, `verifications`, and `status: "passed"` into the official shape.

## Run Artifacts

Each run writes a timestamped directory:

```text
.subagent-runs/
  2026-06-24T12-00-00-000Z/
    run-input.json
    run-summary.json
    tasks/
      review-api/
        prompt.md
        task.json
        stdout.txt
        stderr.txt
        raw-output.json
        result.json
```

AI controllers should prefer these files in order:

1. `run-summary.json` for the whole run.
2. `tasks/<id>/result.json` for one normalized task result.
3. `tasks/<id>/raw-output.json` only when debugging Claude's original envelope.
4. `stdout.txt` and `stderr.txt` only when process-level diagnosis is needed.

AI 总控读取顺序建议：

1. 先读 `run-summary.json` 判断总体是否完成。
2. 再读 `tasks/<id>/result.json` 获取单个子任务的结构化结果。
3. 只有调试 Claude 原始输出时才读 `raw-output.json`。
4. 只有排查进程问题时才读 `stdout.txt` 和 `stderr.txt`。

## Repository Layout

```text
.
|-- bin/
|   `-- subagent-control-protocol.mjs
|-- docs/
|   |-- mcp-optimization-roadmap.md
|   `-- subagent-protocol.md
|-- examples/
|   |-- mcp-config/
|   `-- plans/
|-- schemas/
|   |-- agent-result.schema.json
|   `-- task-plan.schema.json
|-- scripts/
|   |-- check-text-health.mjs
|   |-- run-claude-agents.mjs
|   `-- smoke-mcp.mjs
|-- src/
|   |-- core/
|   `-- server.mjs
`-- package.json
```

## Safety Notes

- Do not commit API keys, Claude tokens, browser profiles, or run logs.
- Use private repositories when prompts may contain proprietary project context.
- Keep implementation tasks single-writer unless file ownership is explicit.
- Use parallelism first for planning, research, review, and verification.
- Use `dryRun: true` when checking task decomposition or MCP wiring.

## 中文速览

SCP 是“Codex 总控 + Claude 子 agent”的 MCP 化执行层。它解决的核心问题是：总控不仅能发起 Claude Code CLI 任务，还能拿回可机读、可追踪、可复盘的结果。

常见用法：

- 让多个 Claude 子 agent 并行做 review、research、verify；
- 让实现任务保持单写者，避免并发改同一批文件；
- 对每次子 agent 调用留下 prompt、日志、原始输出和归一化结果；
- 让 Codex 根据 `structuredContent` 或 `run-summary.json` 做下一步决策。

最小验证：

```powershell
npm install
npm run check
npm run smoke:mcp
node .\scripts\run-claude-agents.mjs --plan .\examples\plans\runner-smoke.plan.json --dry-run
```

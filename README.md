# Subagent Control Protocol

English | 中文

Subagent Control Protocol, or SCP, is an MCP-ready control plane for running
Claude Code CLI as a bounded subagent under a Codex-style orchestrator.

Subagent Control Protocol，简称 SCP，是一个面向 MCP 的子 agent 控制面。它让
Codex 这类总控 agent 可以把 Claude Code CLI 当作可约束、可验证、可追踪的子
agent 来调用。

> Current status: this repository is a local CLI reference implementation plus
> MCP design. The next step is to wrap the same protocol as a first-class MCP
> server.
>
> 当前状态：本仓库是本地 CLI 参考实现 + MCP 设计稿。下一步会把同一套协议封装成
> 一等 MCP server。

## What It Is

SCP is not just a prompt template. It is a small execution layer that gives a
controller agent a reliable way to:

- start Claude Code subagent tasks;
- run independent tasks in parallel;
- enforce task dependencies;
- capture stdout, stderr, raw Claude JSON, normalized results, and usage;
- kill timed-out process trees;
- run repeatable verification checks;
- keep generated run artifacts out of git.

SCP 不只是 prompt 模板。它是一层小型执行控制层，让总控 agent 可以稳定地：

- 启动 Claude Code 子 agent 任务；
- 并行运行互不冲突的任务；
- 管理任务依赖；
- 捕获 stdout、stderr、Claude 原始 JSON、归一化结果和 usage；
- 清理超时任务进程树；
- 执行可重复的验证检查；
- 避免把运行产物提交进 git。

## Why This Exists

When Codex calls Claude Code directly through `claude -p`, the answer often
comes back as free-form prose. That is hard for a controller to trust.

This project turns subagent execution into a contract:

1. The controller submits a task plan.
2. Claude Code runs as one or more subagents.
3. Each subagent returns structured JSON.
4. The runner writes logs and normalized results.
5. The controller reads machine-friendly evidence and decides the next step.

当 Codex 直接通过 `claude -p` 调 Claude Code 时，返回结果往往是自然语言。自然语言
适合人读，但不适合总控 agent 稳定判断。

本项目把子 agent 执行变成一个契约：

1. 总控提交任务计划。
2. Claude Code 作为一个或多个子 agent 运行。
3. 每个子 agent 返回结构化 JSON。
4. runner 写入日志和归一化结果。
5. 总控读取机器友好的证据，再决定下一步。

## Typical Use Cases

- Let Codex delegate planning, review, research, or verification to Claude.
- Run multiple read-only review agents in parallel.
- Keep implementation as a single-writer task while reviews run separately.
- Capture token/cost usage for every Claude subagent call.
- Verify frontend projects with headless Chrome after code changes.
- Scan source files for mojibake or encoding residue before delivery.

典型场景：

- 让 Codex 把规划、审查、研究或验证任务派给 Claude。
- 并行运行多个只读 review agent。
- 让实现阶段保持单写者，同时让审查任务独立运行。
- 记录每次 Claude 子 agent 调用的 token/cost usage。
- 代码变更后用 headless Chrome 验证前端项目。
- 交付前扫描源码中的乱码或编码残留。

## Repository Layout

```text
.
|-- docs/
|   |-- mcp-optimization-roadmap.md
|   `-- subagent-protocol.md
|-- examples/
|   |-- frontend-parallel.plan.json
|   `-- runner-smoke.plan.json
|-- schemas/
|   |-- agent-result.schema.json
|   `-- task-plan.schema.json
|-- scripts/
|   |-- check-text-health.mjs
|   |-- run-claude-agents.mjs
|   `-- verify-vite-app.mjs
|-- package.json
`-- README.md
```

## Requirements

- Node.js 20 or newer.
- Claude Code CLI installed and authenticated.
- Git.
- Google Chrome, only needed for frontend smoke verification.
- Windows is supported. The runner resolves the real Claude executable behind
  `claude.cmd` and can clean up process trees with `taskkill`.

依赖要求：

- Node.js 20 或更高版本。
- 已安装并完成认证的 Claude Code CLI。
- Git。
- Google Chrome，仅前端烟测需要。
- 支持 Windows。runner 会解析 `claude.cmd` 背后的真实 Claude 可执行文件，并可用
  `taskkill` 清理进程树。

## Quick Start

Run a dry-run scheduler check:

```powershell
node .\scripts\run-claude-agents.mjs --plan .\examples\frontend-parallel.plan.json --concurrency 2 --dry-run
```

Run a real Claude structured-output smoke test:

```powershell
node .\scripts\run-claude-agents.mjs --plan .\examples\runner-smoke.plan.json --concurrency 1
```

Run the text health checker:

```powershell
node .\scripts\check-text-health.mjs --root . --out .\.agent-checks\text-health-report.json
```

Run a Vite frontend smoke check:

```powershell
node .\scripts\verify-vite-app.mjs --project ..\your-vite-app --expected-text App --screenshot ..\.generated\frontend-smoke.png
```

快速开始：

```powershell
# 调度 dry-run，不实际调用 Claude
node .\scripts\run-claude-agents.mjs --plan .\examples\frontend-parallel.plan.json --concurrency 2 --dry-run

# 真实调用 Claude，验证结构化输出链路
node .\scripts\run-claude-agents.mjs --plan .\examples\runner-smoke.plan.json --concurrency 1

# 扫描文本健康状态
node .\scripts\check-text-health.mjs --root . --out .\.agent-checks\text-health-report.json

# 验证 Vite 前端项目
node .\scripts\verify-vite-app.mjs --project ..\your-vite-app --expected-text App --screenshot ..\.generated\frontend-smoke.png
```

## Creating A Task Plan

A task plan is a JSON file. It describes the workspace, shared Claude options,
and the subagent tasks to run.

任务计划是一个 JSON 文件，用来描述工作目录、Claude 共享参数和要运行的子 agent
任务。

```json
{
  "version": 1,
  "workspace": "../my-project",
  "outputDir": "../.agent-runs",
  "defaults": {
    "model": "sonnet",
    "effort": "medium",
    "timeoutMs": 600000,
    "permissionMode": "acceptEdits"
  },
  "tasks": [
    {
      "id": "review-layout",
      "title": "Review the layout implementation",
      "kind": "review",
      "prompt": "Review the current frontend layout for defects. Do not edit files."
    },
    {
      "id": "review-state",
      "title": "Review state management",
      "kind": "review",
      "prompt": "Review state management for bugs and missing edge cases. Do not edit files."
    },
    {
      "id": "summarize-findings",
      "title": "Summarize review findings",
      "kind": "verify",
      "dependsOn": ["review-layout", "review-state"],
      "tools": [],
      "prompt": "Summarize the completed review outputs into a concise structured result."
    }
  ]
}
```

Run it:

```powershell
node .\scripts\run-claude-agents.mjs --plan .\my-plan.json --concurrency 2
```

运行：

```powershell
node .\scripts\run-claude-agents.mjs --plan .\my-plan.json --concurrency 2
```

## Reading The Output

Each run writes a timestamped artifact directory:

```text
.agent-runs/
  2026-06-23T10-00-19-507Z/
    run-input.json
    run-summary.json
    tasks/
      review-layout/
        prompt.md
        task.json
        stdout.txt
        stderr.txt
        raw-output.json
        result.json
```

Important files:

- `run-summary.json`: overall task status, max parallelism, failed tasks.
- `tasks/<id>/result.json`: normalized result for one subagent.
- `tasks/<id>/raw-output.json`: raw Claude JSON envelope.
- `tasks/<id>/stdout.txt` and `stderr.txt`: process logs.

重要文件：

- `run-summary.json`：整体任务状态、实际最大并行数、失败任务。
- `tasks/<id>/result.json`：某个子 agent 的归一化结果。
- `tasks/<id>/raw-output.json`：Claude 原始 JSON envelope。
- `tasks/<id>/stdout.txt` 和 `stderr.txt`：进程日志。

## MCP Tool Model

The current repository is a CLI reference implementation. The planned MCP
server should expose the same control model through tools like:

- `subagent.spawn`: start one subagent task.
- `subagent.run_many`: run multiple dependency-aware tasks.
- `subagent.cancel`: cancel one running task.
- `subagent.status`: inspect live task status and log offsets.

当前仓库是 CLI 参考实现。计划中的 MCP server 应该通过以下工具暴露同一套控制模型：

- `subagent.spawn`：启动一个子 agent 任务。
- `subagent.run_many`：运行多个带依赖关系的任务。
- `subagent.cancel`：取消一个运行中的任务。
- `subagent.status`：查看实时任务状态和日志偏移。

See `docs/mcp-optimization-roadmap.md` for the full design.

完整设计见 `docs/mcp-optimization-roadmap.md`。

## CLI Tools

### `run-claude-agents.mjs`

Runs Claude Code subagents from a task plan.

```powershell
node .\scripts\run-claude-agents.mjs --plan .\examples\runner-smoke.plan.json --concurrency 1
```

Key options:

- `--plan PATH`: task plan JSON.
- `--concurrency N`: max parallel tasks.
- `--dry-run`: write commands and prompts without invoking Claude.
- `--workspace PATH`: override the plan workspace.
- `--out PATH`: override the output directory.
- `--claude PATH`: override the Claude executable.

### `check-text-health.mjs`

Scans text files for replacement characters and common mojibake patterns.

```powershell
node .\scripts\check-text-health.mjs --root . --out .\.agent-checks\text-health-report.json
```

### `verify-vite-app.mjs`

Builds or serves a Vite app, opens it with headless Chrome, checks expected
text, and captures a screenshot.

```powershell
node .\scripts\verify-vite-app.mjs --project ..\your-vite-app --expected-text App
```

## Subagent Result Contract

Each subagent should return a result compatible with
`schemas/agent-result.schema.json`.

每个子 agent 应返回兼容 `schemas/agent-result.schema.json` 的结构化结果。

Core fields:

- `status`: `completed`, `partial`, `blocked`, or `failed`.
- `summary`: factual summary.
- `filesChanged`: changed files.
- `commandsRun`: commands and pass/fail/skipped state.
- `verification`: checks and evidence.
- `risks`: remaining risks.
- `nextSteps`: concrete follow-up actions.
- `metrics`: optional token/cost metrics.

The runner also normalizes common variants such as `files_changed`,
`verifications`, and `status: "passed"` into the official result shape.

runner 也会把 `files_changed`、`verifications`、`status: "passed"` 等常见变体
归一化成正式结果结构。

## Practical Guidance

- Use parallelism for planning, research, review, and verification.
- Keep implementation single-writer unless file ownership is explicit.
- Use `"tools": []` for pure structured-output tasks.
- Avoid `permissionMode: "plan"` for one-shot JSON tasks.
- Keep `.agent-runs/` and `.agent-checks/` out of git.
- Use low budgets for smoke tests.

实践建议：

- 规划、研究、审查、验证适合并行。
- 实现阶段默认单写者，除非文件边界非常清楚。
- 纯结构化输出任务使用 `"tools": []`。
- 一次性 JSON 任务避免使用 `permissionMode: "plan"`。
- 不要把 `.agent-runs/` 和 `.agent-checks/` 提交进 git。
- smoke test 使用低预算。

## Safety

- Do not commit API keys, tokens, local browser data, or run logs.
- Use private repositories when task prompts may contain project context.
- Review `raw-output.json` before sharing logs outside your organization.

安全说明：

- 不要提交 API key、token、本地浏览器数据或运行日志。
- 当任务 prompt 可能包含项目上下文时，默认使用私有仓库。
- 对外分享日志前，先审查 `raw-output.json`。

## Status

Verified locally on Windows:

- runner dry-run scheduling;
- real Claude structured-output smoke test;
- text health checks;
- Vite frontend smoke verification.

已在 Windows 本地验证：

- runner dry-run 调度；
- Claude 真实结构化输出 smoke test；
- 文本健康检查；
- Vite 前端烟测。


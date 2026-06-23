# Subagent Control Protocol

> A local control protocol for Codex-led Claude Code subagents.
>
> Codex 作为总控，Claude Code CLI 作为可约束、可验证、可追踪的子 agent。

## Overview / 概览

**Subagent Control Protocol** is a small local toolkit for running Claude Code CLI
as controlled subagents under a Codex-style orchestrator.

它解决的问题很直接：当 Codex 作为总控调用 Claude Code CLI 时，子 agent
不能只输出一段自然语言。它需要返回结构化结果、可追踪日志、验证证据、风险说明和
token/cost usage，这样总控才能稳定接收、判断和继续调度。

This repository provides:

- A task-plan protocol for serial and parallel subagent work.
- A Claude Code runner with dependency-aware scheduling.
- Structured JSON result normalization.
- Timeout handling and Windows process-tree cleanup.
- Text health checks for mojibake and encoding residue.
- Vite/frontend smoke verification through headless Chrome.
- Documentation for a future first-class MCP implementation.

本仓库提供：

- 子 agent 任务计划协议，支持串行和并行任务。
- Claude Code CLI runner，支持依赖调度。
- 结构化 JSON 结果归一化。
- 超时处理和 Windows 进程树清理。
- 乱码与编码残留扫描。
- 基于 headless Chrome 的 Vite/前端烟测。
- 后续升级成一等 MCP 工具的设计文档。

## Why / 为什么需要它

In multi-agent coding work, "the subagent said it is done" is not enough.
The controller needs machine-readable evidence:

- What changed?
- Which commands ran?
- Did verification pass?
- What risks remain?
- How much did the subagent spend?
- Did any subtask time out or get blocked?

多 agent 施工里，“子 agent 说完成了”是不够的。总控需要可机器读取的证据：

- 改了哪些文件？
- 跑了哪些命令？
- 验证是否通过？
- 还剩哪些风险？
- 子 agent 消耗了多少？
- 是否有任务超时或阻塞？

This protocol turns subagent output into a predictable contract.

这个协议把子 agent 输出变成可依赖的契约。

## Repository Name / 仓库命名

Official name:

```text
Subagent Control Protocol
```

Recommended repository slug:

```text
subagent-control-protocol
```

Short form:

```text
SCP
```

## Directory Layout / 目录结构

```text
.
├── docs/
│   ├── mcp-optimization-roadmap.md
│   └── subagent-protocol.md
├── examples/
│   ├── frontend-parallel.plan.json
│   └── runner-smoke.plan.json
├── schemas/
│   ├── agent-result.schema.json
│   └── task-plan.schema.json
├── scripts/
│   ├── check-text-health.mjs
│   ├── run-claude-agents.mjs
│   └── verify-vite-app.mjs
├── package.json
└── README.md
```

## Quick Start / 快速开始

Run a dry-run scheduler check:

```powershell
node .\scripts\run-claude-agents.mjs --plan .\examples\frontend-parallel.plan.json --concurrency 2 --dry-run
```

Run a real structured Claude smoke test:

```powershell
node .\scripts\run-claude-agents.mjs --plan .\examples\runner-smoke.plan.json --concurrency 1
```

Run text health checks:

```powershell
node .\scripts\check-text-health.mjs --root . --out .\.agent-checks\text-health-report.json
```

Run a Vite frontend smoke check:

```powershell
node .\scripts\verify-vite-app.mjs --project ..\incense-cultivation-game --expected-text PixiJS --expected-text HTMLText --screenshot ..\.generated\frontend-smoke.png
```

## Task Plan Contract / 任务计划契约

A task plan is a JSON file with:

- `version`: protocol version.
- `workspace`: working directory.
- `outputDir`: run artifact directory.
- `defaults`: shared Claude CLI options.
- `tasks`: task list.

任务计划是一个 JSON 文件，包含：

- `version`：协议版本。
- `workspace`：工作目录。
- `outputDir`：运行产物目录。
- `defaults`：Claude CLI 默认参数。
- `tasks`：任务列表。

Minimal example:

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
      "id": "review-ui",
      "title": "Review UI implementation",
      "kind": "review",
      "prompt": "Review the current UI for layout bugs. Do not edit files."
    }
  ]
}
```

## Subagent Result Contract / 子 agent 结果契约

Every subagent should return a result compatible with
[`schemas/agent-result.schema.json`](schemas/agent-result.schema.json).

每个子 agent 都应该返回兼容
[`schemas/agent-result.schema.json`](schemas/agent-result.schema.json)
的结构化结果。

Core fields:

- `status`: `completed`, `partial`, `blocked`, or `failed`
- `summary`: factual summary
- `filesChanged`: changed files
- `commandsRun`: commands and status
- `verification`: checks and evidence
- `risks`: remaining risks
- `nextSteps`: concrete follow-up actions
- `metrics`: optional token/cost metrics

核心字段：

- `status`：`completed`、`partial`、`blocked` 或 `failed`
- `summary`：事实性总结
- `filesChanged`：变更文件
- `commandsRun`：命令与状态
- `verification`：检查项与证据
- `risks`：剩余风险
- `nextSteps`：后续动作
- `metrics`：可选 token/cost 指标

The runner also normalizes common variants such as `files_changed`,
`verifications`, and `status: "passed"` into the official result shape.

runner 会将 `files_changed`、`verifications`、`status: "passed"` 等常见变体归一化
为正式协议形态。

## Runner Behavior / Runner 行为

`scripts/run-claude-agents.mjs`:

- Resolves the real Claude executable on Windows.
- Sends the prompt through stdin.
- Supports dependency-aware scheduling.
- Tracks `maxParallelObserved`.
- Writes one artifact folder per task.
- Captures stdout, stderr, raw Claude JSON, normalized result, and usage.
- Kills timed-out process trees.
- Supports `--tools ""` through `"tools": []`.

`scripts/run-claude-agents.mjs` 会：

- 在 Windows 上解析真实 Claude 可执行文件。
- 通过 stdin 发送 prompt。
- 支持依赖感知调度。
- 记录实际最大并行数 `maxParallelObserved`。
- 为每个任务写入独立产物目录。
- 捕获 stdout、stderr、Claude 原始 JSON、归一化结果和 usage。
- 清理超时任务的进程树。
- 通过 `"tools": []` 支持 `--tools ""`。

Run artifacts look like:

```text
.agent-runs/
  2026-06-23T10-00-19-507Z/
    run-input.json
    run-summary.json
    tasks/
      runner-smoke/
        prompt.md
        task.json
        stdout.txt
        stderr.txt
        raw-output.json
        result.json
```

## Guidance For AI Agents / 给 AI Agent 的阅读说明

If you are an AI agent using this repository:

1. Read `docs/subagent-protocol.md` first.
2. Use `examples/runner-smoke.plan.json` to confirm Claude CLI integration.
3. Use `examples/frontend-parallel.plan.json` as a pattern for parallel review.
4. Treat `.agent-runs/` and `.agent-checks/` as generated artifacts.
5. Do not commit secrets, API keys, local browser data, or run logs.
6. Prefer planning/review/verification in parallel.
7. Prefer implementation in a single writer unless file ownership is clear.

如果你是使用本仓库的 AI agent：

1. 先读 `docs/subagent-protocol.md`。
2. 用 `examples/runner-smoke.plan.json` 验证 Claude CLI 集成。
3. 用 `examples/frontend-parallel.plan.json` 作为并行 review 模板。
4. 将 `.agent-runs/` 和 `.agent-checks/` 视为生成产物。
5. 不要提交密钥、API key、本地浏览器数据或运行日志。
6. 规划、审查、验证适合并行。
7. 实现阶段默认单写者，除非文件边界非常清楚。

## MCP Roadmap / MCP 路线图

This repository is currently a local CLI toolkit. The intended next step is a
first-class MCP server exposing:

- `subagent.spawn`
- `subagent.run_many`
- `subagent.cancel`
- `subagent.status`

当前仓库是本地 CLI 工具包。下一步目标是升级为一等 MCP server，暴露：

- `subagent.spawn`
- `subagent.run_many`
- `subagent.cancel`
- `subagent.status`

See [`docs/mcp-optimization-roadmap.md`](docs/mcp-optimization-roadmap.md).

## Safety / 安全边界

- Keep repositories private by default when prompts or logs may contain project context.
- Do not commit `.agent-runs/`, `.agent-checks/`, `.env`, or credentials.
- Use low budgets for smoke tests.
- Use `"tools": []` for pure structured-output tasks.
- Avoid `permissionMode: "plan"` for one-shot JSON tasks.

- 当 prompt 或日志可能包含项目上下文时，默认使用私有仓库。
- 不要提交 `.agent-runs/`、`.agent-checks/`、`.env` 或任何凭据。
- smoke test 使用低预算。
- 纯结构化输出任务使用 `"tools": []`。
- 一次性 JSON 任务避免使用 `permissionMode: "plan"`。

## Status / 当前状态

Verified locally on Windows:

- Runner dry-run scheduling.
- Real Claude structured-output smoke test.
- Text health checks.
- Vite frontend smoke verification.

已在 Windows 本地验证：

- runner dry-run 调度。
- Claude 真实结构化输出 smoke test。
- 文本健康检查。
- Vite 前端烟测。


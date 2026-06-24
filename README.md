# Subagent Control Protocol

**Subagent Control Protocol (SCP)** is an installable MCP server that lets Codex act as the controller and delegate bounded work to Claude Code CLI subagents. Each subagent returns a structured, machine-readable result — files changed, commands run, verification evidence, risks, next steps, and token/cost evidence — so Codex can decide the next step instead of scraping terminal output.

**Subagent Control Protocol（SCP）** 是一个可直接安装的 MCP Server。它让 Codex 作为总控，把明确边界的任务分派给 Claude Code CLI 子 agent，并以结构化、可机读的形式收回结果（改了哪些文件、跑了哪些命令、验证证据、风险、下一步、token/成本证据）。这样总控可以根据结果决定下一步，而不必解析终端输出。

## Why It Exists

Codex is good at planning and integration, but a single long `claude -p` call gives back only free text. SCP fixes the "controller calls subagent" link:

- Codex decides task decomposition, ownership, and acceptance criteria.
- Claude Code CLI executes the bounded local task as a subagent.
- The MCP server handles process lifecycle, concurrency, logging, structured output, and run archival.
- Codex reads `run-summary.json` and the MCP `structuredContent`, then decides what to do next.

SCP 的目标不是替代 Codex，而是补齐“总控调用子 agent”这条链路：单次长 `claude -p` 调用只会返回自由文本，而 SCP 让每次子 agent 调用都产出可追踪、可复盘的结构化结果。

## Architecture

```text
Codex (controller)
   │  decides decomposition, ownership, acceptance, integration
   ▼
Skill layer  (skills/subagent-orchestrator/SKILL.md)
   │  workflow rules: when to delegate, read-only vs implement, non-overlap
   ▼
MCP layer  (src/server.mjs — processes & tools)
   │  process lifecycle, concurrency, logging, structured output
   ▼
Claude Code CLI  (executor — `claude -p`)
   │  runs the bounded task, returns agent-result JSON
   ▼
Run artifacts  (.subagent-runs/<ts>/...)
```

- **Codex controller** — decomposes work, dispatches tasks, reads results, integrates and ships.
- **Skill workflow layer** — governs *when* and *how* to delegate: read-only review, non-overlapping implementation, verification, single-vs-many delegation.
- **MCP process/tool layer** — manages Claude child processes, bounded concurrency, timeouts, cancellation, and structured output. Exposes four tools.
- **Claude Code CLI executor** — runs each bounded task and returns JSON matching the result contract.

四层分工：Codex 总控负责拆分与集成；Skill 层定义何时/如何委派；MCP 层负责进程、并发、超时与结构化输出；Claude Code CLI 作为执行者运行局部任务并返回符合结果契约的 JSON。

## Installation

New users should install both parts:

- the **MCP server command**, so Codex can call `subagent_run_task`,
  `subagent_run_many`, `subagent_status`, and `subagent_cancel`;
- the **orchestrator Skill**, so Codex knows when to create a `todoList`, when
  work can run in parallel, and when to add the two read-only review agents.

Requirements: Node.js 20+, Claude Code CLI installed and authenticated
(`claude` works in a terminal), and an MCP-capable Codex client.

新用户建议同时安装两部分：MCP Server 命令负责执行子 agent，orchestrator Skill
负责让 Codex 自动遵守 `todoList`、并行分析、双 review 与总控整合流程。

### 1. Clone and verify

```bash
git clone https://github.com/Bohaohao/subagent-control-protocol.git
cd subagent-control-protocol
npm install
npm run check      # syntax-check all sources and scripts
npm run smoke:mcp  # exercise the MCP server end-to-end
```

You can run the server locally for a quick check:

```bash
npm start
# or: node ./bin/subagent-control-protocol.mjs
```

### 2. Register the global MCP command

This repository is not published to npm yet. Link it from the cloned checkout so
`subagent-control-protocol` is callable by name.

```bash
cd /path/to/subagent-control-protocol
npm install
npm link
```

### 3. Add the Codex MCP config

Add this to `~/.codex/config.toml`.

Windows:

```toml
[mcp_servers.subagent-control-protocol]
type = "stdio"
command = "cmd"
args = ["/c", "subagent-control-protocol"]
startup_timeout_sec = 120
tool_timeout_sec = 1200

[mcp_servers.subagent-control-protocol.env]
CLAUDE_BIN = "claude"
```

macOS / Linux:

```toml
[mcp_servers.subagent-control-protocol]
type = "stdio"
command = "subagent-control-protocol"
args = []
startup_timeout_sec = 120
tool_timeout_sec = 1200

[mcp_servers.subagent-control-protocol.env]
CLAUDE_BIN = "claude"
```

If Claude is not on `PATH`, set `CLAUDE_BIN` to the absolute path of the
Claude Code CLI executable.

### 4. Install the orchestrator Skill

Copy the Skill into your global Codex skills directory.

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.codex\skills\subagent-orchestrator"
Copy-Item -Recurse -Force ".\skills\subagent-orchestrator\*" "$HOME\.codex\skills\subagent-orchestrator\"
```

macOS / Linux:

```bash
mkdir -p ~/.codex/skills/subagent-orchestrator
cp -R ./skills/subagent-orchestrator/. ~/.codex/skills/subagent-orchestrator/
```

Restart Codex, or start a new Codex thread, after installing the MCP config and
Skill. In a session, run `/mcp` to confirm the server is available.

### Updating an existing install

```bash
cd /path/to/subagent-control-protocol
git pull
npm install
npm link
```

Then copy `skills/subagent-orchestrator/` into `~/.codex/skills/` again and
restart Codex or open a new thread.

## Plugin Bundle

This repo is installable as a Codex plugin. The bundle is made of three parts:

- `.codex-plugin/plugin.json` — plugin manifest: name, version, description, capabilities, default prompts.
- `.mcp.json` — MCP server registration (command + env) referenced by the manifest's `mcpServers`.
- `skills/` — workflow Skills (e.g. `skills/subagent-orchestrator/SKILL.md`) that teach Codex *when* and *how* to delegate.

Install the plugin into Codex and it registers the MCP server and the orchestrator Skill together, so delegation rules and the execution tools arrive as one unit.

Use the plugin bundle when your Codex environment supports local plugin
marketplaces. The repository itself is a plugin bundle, not a marketplace root;
a marketplace is a parent index that points at plugin bundles. If you install
through a Codex plugin marketplace, you do not need the manual Skill copy step
above.

把仓库作为 Codex 插件安装时，三部分协同生效：`plugin.json` 是清单，`.mcp.json` 注册 MCP Server，`skills/` 提供委派时机与方式的工作流规则。安装后执行工具与委派规则一同就位。

## Minimal Prompt & Controller Workflow

In normal use you do **not** need to specify concurrency or detailed MCP parameters in your prompt. Give Codex the task; the controller (Codex + the orchestrator Skill) decides decomposition, concurrency, and dispatch, while the MCP layer handles process lifecycle and structured output. The user-facing prompt can be minimal.

正常使用时，你**无需**在 prompt 中指定并发或详细的 MCP 参数。给出任务即可：总控（Codex + orchestrator Skill）决定拆分、并发与派发，MCP 层负责进程生命周期与结构化输出。面向用户的 prompt 可以非常精简。

### Minimal prompt (recommended)

- **中文（推荐）:**
  > 用 Claude 子 agent 施工这个任务。

- **English (recommended):**
  > Use Claude subagents to work on this task.

Optional review-only variants:

- **Review-only variant (EN):**
  > Use Claude subagents to review this task — read-only, no edits.

- **仅评审变体（中文）:**
  > 用 Claude 子 agent 评审这个任务——只读，不改文件。

These prompts contain no concurrency and no `subagent_run_many` / `permissionMode` knobs. That is intentional.

这些 prompt 不含并发、`subagent_run_many` / `permissionMode` 等开关，这是有意为之。

### Controller workflow behind the prompt

You do not need to perform these steps yourself; this section documents what Codex must do as controller.

Given a minimal prompt, Codex drives the full workflow itself:

In plain language: Codex plans the work, runs independent implementers in parallel when safe, runs two read-only reviews after implementation, integrates the findings, and reports one final decision.

1. **Build a `todoList`** — decompose the task into concrete, bounded steps.
2. **Classify parallelizable work** — separate read-only work (review, research, verification) from implementation; mark which steps are independent and which depend on others.
3. **Dispatch subagents from the `todoList`** — send parallelizable steps via `subagent_run_many` (read-only reviewers in parallel; implementation slices with exclusive, non-overlapping file ownership), ordered tasks via `subagent_run_task` with `dependsOn` where needed.
4. **Add review agents** — after implementation, include a software-engineering review subagent and a real-user perspective review subagent (read-only), both depending on the implementers.
5. **Integrate review findings** — read each `run-summary.json` and `tasks/<id>/result.json`, route fixes to the single owning agent of the failing file, and reconcile conflicts.
6. **Report** — synthesize one outcome report and make the final accept/hold/ship decision. Never let a subagent decide merge, release, or push.

收到这类精简 prompt 后，Codex 作为总控自行驱动完整流程：建立 `todoList` → 区分可并行任务 → 按 `todoList` 派发子 agent → 增加“软件工程评审”与“真实用户视角评审”子 agent → 整合评审结论 → 汇总报告并做最终决策。合并、发布、推送等决策始终由总控保留，不下放给子 agent。

### Controller decision vs MCP execution layer

Two distinct layers — keep them separate:

- **Controller decision layer (Codex + Skill)** — owns *what* to do: the `todoList`, parallelization classification, dispatch order, agent prompts, file ownership, and the final accept/integrate/ship decision. This is where concurrency and routing are decided; the user does not state them.
- **MCP execution layer (`src/server.mjs`)** — owns *how* it runs: Claude child-process lifecycle, bounded concurrency enforcement, timeouts, cancellation, logging, structured output, and run archival. It exposes the four tools but does not decide decomposition.

两层要分开看：决策层（总控 + Skill）负责“做什么”——`todoList`、可并行分类、派发顺序、prompt、文件归属与最终决策，并发与路由在此决定，用户无需指定；执行层（MCP Server）负责“怎么跑”——进程生命周期、有界并发、超时、取消、日志、结构化输出与归档，只暴露工具，不参与拆分。

## Usage — Prompt Examples

Most users should stop at the minimal prompts above. The examples below are optional advanced forms for cases where you want to hand the controller precise knobs.

上文的最小化 prompt 是推荐默认。下方示例为显式完整形式，适用于你想给总控精确开关的情况。

### Parallel read-only review (EN)

> You are the controller. Delegate a parallel, read-only code review via `subagent_run_many` with `concurrency: 3` and `permissionMode: "default"`. Three reviewers — security, API regressions, test coverage — each read-only, no `dependsOn` between them. Do not edit files yourself unless a reviewer flags a critical blocker. After the run, read `run-summary.json` and each `tasks/<id>/result.json`, synthesize one report, and you (Codex) make the final accept/reject/revise decision. Cite `measuredUsageSummary`/`usage` for token-cost evidence.

### 并行只读评审（中文）

> 你是总控。通过 `subagent_run_many` 发起并行只读代码评审，`concurrency: 3`，`permissionMode: "default"`。三个评审子 agent 分别负责安全、API 回归、测试覆盖，互不依赖、互不编辑文件。除非有评审者标记关键阻塞，否则你不要亲自改文件。运行后读取 `run-summary.json` 与各 `tasks/<id>/result.json`，综合成一份报告，由你（Codex）做最终的接受/驳回/修订决策。token/成本证据引用 `measuredUsageSummary`/`usage`。

### Non-overlapping implementation (EN)

> You are the controller. Decompose the change into non-overlapping implementation slices and dispatch them in parallel via `subagent_run_many`. Each subagent gets an EXCLUSIVE file set — no two subagents may edit the same file. State each subagent's owned files in its prompt and forbid edits outside that set. Set `concurrency` to the number of implementers. After the run, cross-check `filesChanged` across results for collisions, run the full `npm run check` + `npm run smoke:mcp`, and route any fix to the single owning agent of the failing file. You make the final ship/hold decision.

### 互不重叠的实现（中文）

> 你是总控。把改动拆成互不重叠的实现切片，通过 `subagent_run_many` 并行派发。每个子 agent 拥有独占的文件集合——任何两个子 agent 不得编辑同一文件。在各自的 prompt 中声明拥有的文件，并禁止改动该集合之外的内容。`concurrency` 设为实现者数量。运行后交叉比对各结果的 `filesChanged` 检查冲突，运行完整的 `npm run check` 与 `npm run smoke:mcp`；若集成失败，把修复定向给失败文件的那个所有者。最终是否发布由你决定。

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `subagent_run_task` | Run one bounded Claude subagent task; returns `{ runSummary, results, result }` where `result` is the single task. |
| `subagent_run_many` | Run a dependency-aware plan with bounded concurrency; returns `{ runSummary, results }` in input order. Use for parallel review/verification or non-overlapping implementation. |
| `subagent_status` | Read one `run-summary.json` (mode `single`) or list recent runs from an output dir (mode `list`); both include the active-process list. |
| `subagent_cancel` | Best-effort cancellation for active Claude child processes in this server process. Requires `runId`. |

Every tool returns a shared envelope: `{ ok: true, ...payload }` on success, or `{ ok: false, error: { code, message, stack? } }` (with `isError: true`) on failure. All run tools include `runSummary` in `structuredContent`.

## Result Contract

Every Claude subagent is asked to return JSON matching `schemas/agent-result.schema.json`:

- `status` — `completed` | `partial` | `blocked` | `failed`
- `summary` — factual outcome
- `filesChanged` — files changed and why
- `commandsRun` — commands with pass/fail/skipped state
- `verification` — checks and evidence
- `risks` — remaining risks with severity
- `nextSteps` — concrete follow-up actions
- `tokenUsageSummary` — **required, always.** A Claude-authored note on whether exact token usage was visible; never fabricate exact counts.
- `metrics` — optional token/cost numbers when visible.

The runner normalizes common variants (`files_changed`, `verifications`, `status: "passed"`) into the official shape. The controller also records measured usage from the Claude CLI envelope as `usage` and `measuredUsageSummary` when available — prefer these over the subagent's self-report for actual token/cost.

Prefer MCP-measured numbers over the subagent's self-report: use `measuredUsageSummary`/`usage` as the source of truth, and `tokenUsageSummary` only as qualitative context.

每个子 agent 必须返回符合 `schemas/agent-result.schema.json` 的 JSON，`tokenUsageSummary` 为必填项且不得编造确切 token 数。实际 token/成本以 MCP 从 Claude CLI 信封采集的 `usage`/`measuredUsageSummary` 为准，子 agent 自报仅作参考。

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

Read order for controllers:

1. `run-summary.json` — overall run status.
2. `tasks/<id>/result.json` — one normalized task result.
3. `tasks/<id>/raw-output.json` — only when debugging Claude's original envelope.
4. `stdout.txt` / `stderr.txt` — only for process-level diagnosis.

## Safety Notes

- Do not commit API keys, Claude tokens, browser profiles, or run logs.
- Use private repositories when prompts may contain proprietary project context.
- Parallelize read-only work (review, research, verification) first.
- Keep implementation single-writer with explicit, non-overlapping file ownership; never let two subagents edit the same file concurrently.
- Use `dryRun: true` to validate task decomposition or MCP wiring before a real run.
- Treat `permissionMode: "bypassPermissions"` and `"auto"` as privileged modes; prefer isolated workspaces for delegated tasks and never use them on shared trees.
- Never delegate merge, release, or push decisions to a subagent — Codex stays the final integrator.

## Development Checks

```bash
npm run check        # node --check on bin, src, and scripts
npm run smoke:mcp    # end-to-end MCP server smoke test
npm run text:check   # text-health report (encoding/mojibake scan)
npm run agent:run -- --plan ./examples/plans/runner-smoke.plan.json --dry-run
```

Run `npm run check` and `npm run smoke:mcp` after any source change. `npm run text:check` writes `./.agent-checks/text-health-report.json` and flags encoding problems.

## Repository Layout

```text
.
├── bin/                      # package bin entrypoint
├── .codex-plugin/plugin.json # Codex plugin manifest
├── skills/                   # workflow Skills (orchestration rules)
├── src/
│   ├── core/                 # scheduler, claude-runner, result normalizer, process tree
│   └── server.mjs            # MCP server + tool definitions
├── schemas/                  # agent-result.schema.json, task-plan.schema.json
├── scripts/                  # run-claude-agents, smoke-mcp, check-text-health
├── examples/                 # mcp-config, plans, prompts
├── docs/                     # protocol + roadmap docs
└── package.json
```

## License

MIT © Bohaohao

# Subagent Control Protocol

**Subagent Control Protocol (SCP)** is an installable Codex plugin for orchestrating Claude Code CLI subagents. It bundles two things that work together: an MCP runtime that exposes the execution tools, and an orchestrator Skill that teaches Codex when to split work, run tasks in parallel, add reviewers, and integrate results. Each subagent returns a structured, machine-readable result: files changed, commands run, verification evidence, risks, next steps, and token/cost evidence.

**Subagent Control Protocol（SCP）** 是一个可直接安装的 Codex 插件，用来让 Codex 编排 Claude Code CLI 子 agent。它把两部分打包在一起：负责暴露执行工具的 MCP runtime，以及指导 Codex 何时拆分任务、何时并行、何时追加 review、如何整合结果的 orchestrator Skill。每个子 agent 都会返回结构化、可机读的结果：改了哪些文件、跑了哪些命令、验证证据、风险、下一步、token/成本证据。

## Why It Exists

Codex is good at planning and integration, but a raw `claude -p` call is not a complete product experience for multi-agent work. SCP packages the workflow as a Codex plugin and fixes the "controller calls subagent" link:

- Codex decides task decomposition, ownership, and acceptance criteria.
- Claude Code CLI executes the bounded local task as a subagent.
- The plugin's MCP runtime handles process lifecycle, concurrency, logging, structured output, and run archival.
- Codex reads `run-summary.json` and the MCP `structuredContent`, then decides what to do next.

SCP 的目标不是替代 Codex，而是把“总控调用子 agent”这条链路沉淀成可安装的 Codex 插件：既有执行工具，也有编排规约；每次子 agent 调用都会产出可追踪、可复盘的结构化结果。

## Architecture

```text
Codex (controller)
   │  decides decomposition, ownership, acceptance, integration
   ▼
SCP Codex plugin
   │  installs the Skill workflow layer and MCP runtime together
   ▼
Skill workflow layer  (skills/subagent-orchestrator/SKILL.md)
   │  workflow rules: when to delegate, read-only vs implement, non-overlap
   ▼
MCP runtime layer  (src/server.mjs - processes & tools)
   │  process lifecycle, concurrency, logging, structured output
   ▼
Claude Code CLI  (executor — `claude -p`)
   │  runs the bounded task, returns agent-result JSON
   ▼
Run artifacts  (.subagent-runs/<ts>/...)
```

- **Codex controller** — decomposes work, dispatches tasks, reads results, integrates and ships.
- **SCP Codex plugin** — the installable product: marketplace metadata, plugin manifest, Skill, MCP registration, bundled runtime, and update bootstrap.
- **Skill workflow layer** — governs *when* and *how* to delegate: read-only review, non-overlapping implementation, verification, single-vs-many delegation.
- **MCP runtime/tool layer** — the plugin's execution layer. It manages Claude child processes, bounded concurrency, timeouts, cancellation, and structured output. Exposes four tools.
- **Claude Code CLI executor** — runs each bounded task and returns JSON matching the result contract.

分层关系：Codex 总控负责拆分与集成；SCP 作为 Codex 插件被安装；插件里的 Skill 层定义何时/如何委派；插件里的 MCP runtime 负责进程、并发、超时与结构化输出；Claude Code CLI 作为执行者运行局部任务并返回符合结果契约的 JSON。

## Installation

SCP ships as a single Codex plugin bundle that installs the orchestrator Skill
and the MCP runtime together. Two install paths are supported:

- **Recommended — Codex plugin marketplace.** When your Codex environment
  supports plugin marketplaces, install from this repo and the execution tools
  plus the orchestrator Skill arrive as one unit. No manual Skill copy step is
  needed.
- **Fallback — manual MCP + Skill install.** For environments without plugin
  marketplace support, register the MCP command and copy the Skill by hand.

Either way the installed plugin gives Codex:

- the **execution tool runtime**, so Codex can call `subagent_run_task`,
  `subagent_run_many`, `subagent_status`, and `subagent_cancel`;
- the **orchestrator Skill**, so Codex knows when to create a `todoList`, when
  work can run in parallel, and when to add the two read-only review agents.

### Prerequisites

- **Node.js 20+** (`node -v`).
- **Claude Code CLI** installed and authenticated — `claude` runs in a terminal.
- **A MCP-capable Codex client.**
- **Network access** for marketplace/bootstrap runtime self-update (see
  [Update model](#update-model)). Self-update can be disabled with
  `SCP_DISABLE_AUTO_UPDATE=1` for air-gapped setups. Manual installs update with
  `git pull` instead.

新用户安装插件后即同时获得两部分：执行工具 runtime 负责运行子 agent，orchestrator Skill
负责让 Codex 自动遵守 `todoList`、并行分析、双 review 与总控整合流程。推荐走 Codex
插件市场安装；不支持市场时退回手动安装。

### Install via Codex plugin marketplace (recommended)

Add this repository as a plugin marketplace source, then install/enable the
plugin. Codex marketplace commands evolve between releases; the forms below match
the documented marketplace behavior — if your CLI differs, fall back to the
manual path.

```bash
# Add this repo as a marketplace source (owner/repo, optionally pinned to a ref)
codex plugin marketplace add Bohaohao/subagent-control-protocol
# or pin to a branch/tag:
codex plugin marketplace add Bohaohao/subagent-control-protocol --ref main
```

Then install/enable the plugin. Depending on your Codex build, do this either by
opening the `/plugins` view inside a Codex session, or by using the Codex app
plugin directory. The marketplace metadata may be shown during install. Restart
Codex (or start a new thread) once enabled.

After install, run `/mcp` in a session to confirm the plugin's
`subagent-control-protocol` runtime is available.

### Manual installation (fallback)

Use this when your Codex build has no plugin marketplace support.

#### 1. Clone and verify

```bash
git clone https://github.com/Bohaohao/subagent-control-protocol.git
cd subagent-control-protocol
npm install
npm run check      # syntax-check all sources and scripts
npm run smoke:mcp  # exercise the plugin runtime end-to-end
```

#### 2. Register the global MCP command

This repository is not published to npm. Link it from the cloned checkout so
`subagent-control-protocol` is callable by name.

```bash
cd /path/to/subagent-control-protocol
npm install
npm link
```

#### 3. Add the Codex MCP config

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

#### 4. Install the orchestrator Skill

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

Restart Codex, or start a new Codex thread, after installing the manual MCP
config and Skill. In a session, run `/mcp` to confirm the plugin runtime is
available.

## Update model

There are two independent update channels — keep them separate:

- **Runtime self-update (plugin MCP runtime).** For marketplace installs that launch
  through `dist/bootstrap.mjs`, Codex restart starts the bootstrap launcher. It
  checks an update manifest and runs a newer verified runtime build from the
  local cache before the execution runtime starts. This updates the plugin's MCP
  process/tool layer (`src/`) without touching the marketplace plugin metadata.
  Self-update requires network access; disable it with
  `SCP_DISABLE_AUTO_UPDATE=1`.
- **Skill / plugin metadata updates.** The orchestrator Skill
  (`skills/subagent-orchestrator/SKILL.md`) and plugin manifest
  (`.codex-plugin/plugin.json`) are part of the marketplace bundle. They are
  refreshed only when the marketplace is refreshed / the plugin is upgraded —
  either manually or automatically if your Codex build auto-refreshes
  marketplaces. The runtime self-update does **not** update Skill or plugin
  metadata.

In short: marketplace/bootstrap installs can pick up runtime-only updates on
Codex restart. Skill and plugin metadata follow the marketplace upgrade cycle.
Manual installs do not use the bootstrap path; update them with `git pull`,
`npm link`, and a fresh Skill copy.

更新模型分两条独立通道：运行时自更新在 Codex 重启时由 `dist/bootstrap.mjs` 检查清单
并应用新的插件 MCP runtime（仅更新 `src/` 进程/工具层，不触碰市场插件元数据）；Skill 与
插件元数据则随市场刷新/升级更新，除非 Codex 自动刷新市场，否则需要手动升级。

### Environment controls

| Variable | Purpose |
| --- | --- |
| `SCP_DISABLE_AUTO_UPDATE` | Set to `1` (or any truthy value) to disable runtime self-update at startup for marketplace/bootstrap installs. Use for air-gapped or pinned environments. |
| `SCP_UPDATE_MANIFEST_URL` | Override the manifest URL the bootstrap launcher fetches to check for runtime updates. Defaults to the manifest published with the release. |
| `SCP_UPDATE_CACHE_DIR` | Directory used to store downloaded runtime builds. Override to relocate the cache (e.g. onto writable storage). |
| `CLAUDE_BIN` | Path to the Claude Code CLI executable used to spawn subagents. Set in the plugin MCP env block if `claude` is not on `PATH`. |

### Updating an existing install

Marketplace install:

```bash
# Re-run this to refresh the marketplace source and upgrade the plugin
codex plugin marketplace add Bohaohao/subagent-control-protocol --ref main
# then upgrade/enable via /plugins or your Codex app plugin directory
```

The plugin MCP runtime will self-update on the next Codex restart via
`dist/bootstrap.mjs`; Skill/plugin metadata updates land with the marketplace
upgrade.

Manual install:

```bash
cd /path/to/subagent-control-protocol
git pull
npm install
npm link
```

Then copy `skills/subagent-orchestrator/` into `~/.codex/skills/` again and
restart Codex or open a new thread.

## Plugin Bundle

This repo is a Codex repo marketplace. The repository root contains the
marketplace index, while the installable plugin bundle lives at
`plugins/subagent-control-protocol/`.

- `.agents/plugins/marketplace.json` — repo marketplace index that exposes the plugin with `source.path: "./plugins/subagent-control-protocol"`.
- `plugins/subagent-control-protocol/.codex-plugin/plugin.json` — plugin manifest: name, version, description, capabilities, default prompts.
- `plugins/subagent-control-protocol/.mcp.json` — plugin MCP runtime registration (command + env) referenced by the manifest's `mcpServers`.
- `plugins/subagent-control-protocol/dist/` — bundled MCP runtime (`server.mjs`), startup bootstrap (`bootstrap.mjs`), and update manifest (`latest.json`).
- `plugins/subagent-control-protocol/skills/` — workflow Skills (e.g. `skills/subagent-orchestrator/SKILL.md`) that teach Codex *when* and *how* to delegate.

Install the plugin into Codex and it activates the MCP runtime and the orchestrator Skill together, so delegation rules and the execution tools arrive as one unit. See [Installation](#installation) for the marketplace flow and [Update model](#update-model) for how the bundled runtime self-updates.

The root-level source files remain the development workspace. Running
`npm run build` bundles the runtime and syncs the publishable plugin directory,
so Codex UI can index the plugin using the standard repo marketplace layout. If
you install through a Codex plugin marketplace, you do not need the manual Skill
copy step.

把仓库作为 Codex 插件安装时，这些部分协同生效：`plugin.json` 是插件清单，`.mcp.json` 注册插件内置 MCP runtime，`dist/` 提供打包后的运行时与 bootstrap，`skills/` 提供委派时机与方式的工作流规则。安装后执行工具与委派规则一同就位。

## Minimal Prompt & Controller Workflow

In normal use you do **not** need to specify concurrency or detailed MCP parameters in your prompt. Give Codex the task; the controller (Codex + the orchestrator Skill) decides decomposition, concurrency, and dispatch, while the plugin MCP runtime handles process lifecycle and structured output. The user-facing prompt can be minimal.

正常使用时，你**无需**在 prompt 中指定并发或详细的 MCP 参数。给出任务即可：总控（Codex + orchestrator Skill）决定拆分、并发与派发，插件内置 MCP runtime 负责进程生命周期与结构化输出。面向用户的 prompt 可以非常精简。

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

### Controller decision vs runtime execution layer

Two distinct layers — keep them separate:

- **Controller decision layer (Codex + Skill)** — owns *what* to do: the `todoList`, parallelization classification, dispatch order, agent prompts, file ownership, and the final accept/integrate/ship decision. This is where concurrency and routing are decided; the user does not state them.
- **Plugin MCP runtime (`src/server.mjs`)** — owns *how* it runs: Claude child-process lifecycle, bounded concurrency enforcement, timeouts, cancellation, logging, structured output, and run archival. It exposes the four tools but does not decide decomposition.

两层要分开看：决策层（总控 + Skill）负责“做什么”——`todoList`、可并行分类、派发顺序、prompt、文件归属与最终决策，并发与路由在此决定，用户无需指定；插件内置 MCP runtime 负责“怎么跑”——进程生命周期、有界并发、超时、取消、日志、结构化输出与归档，只暴露工具，不参与拆分。

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
| `subagent_status` | Read one `run-summary.json` (mode `single`) or list recent runs from an output dir (mode `list`); both include the active-process list. In single mode it also surfaces event-aware fields when present — latest heartbeat/phase, a per-task `taskEvents` summary, and a bounded `recentEvents` window (pass `recentEventsLimit` to cap it). Prefer this over reading raw `stdout.txt`/`stderr.txt`. |
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
        events.jsonl
```

`tasks/<id>/events.jsonl` is an append-only log of structured lifecycle events emitted by the runner — task start/exit, `phase_started`, periodic `heartbeat`, `checkpoint`, `blocked`, and `command_started`/`command_finished`. It is a structured event stream, **not** a capture of the subagent's full `stdout`/`stderr`. Read it (or, better, ask `subagent_status` for the derived `taskEvents`/`recentEvents` summary) to track live progress, latest phase, and recent heartbeats without touching process logs.

Event entries are compact JSON objects. Common fields are:

- `type` — event type, such as `task_started`, `phase_started`, `heartbeat`, `checkpoint`, `blocked`, `command_started`, `command_finished`, `process_exited`, or `task_completed`.
- `timestamp` — ISO timestamp.
- `taskId` — subagent task id.
- `message` / `summary` / `reason` — short human-readable context.
- `phase` — current phase for `phase_started`.
- `label` / `command` — short command label for command events; do not include full command output.
- `status` / `exitCode` / `durationMs` — small terminal or command outcome fields when relevant.

The event log is best-effort observability. Both the runtime and the Claude subprocess may append to it, so malformed or interleaved lines are ignored by `subagent_status`; full stdout/stderr remain artifact-only.

Read order for controllers:

1. `run-summary.json` — overall run status.
2. `tasks/<id>/result.json` — one normalized task result.
3. `tasks/<id>/events.jsonl` (or `subagent_status`) — latest heartbeat/phase and recent events for progress tracking.
4. `tasks/<id>/raw-output.json` — only when debugging Claude's original envelope.
5. `stdout.txt` / `stderr.txt` — artifact-only, for process-level diagnosis. Do not read these by default; prefer `subagent_status` and `events.jsonl` for observability.

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
npm run build        # bundle dist/server.mjs and write dist/latest.json
npm run build:check  # syntax-check dist artifacts
npm run verify:bundle
npm run verify:marketplace
npm run smoke:mcp    # end-to-end plugin runtime smoke test
npm run text:check   # text-health report (encoding/mojibake scan)
npm run agent:run -- --plan ./examples/plans/runner-smoke.plan.json --dry-run
```

Run `npm run check`, `npm run build`, `npm run verify:bundle`,
`npm run verify:marketplace`, and `npm run smoke:mcp` after source or packaging
changes. `npm run text:check` writes `./.agent-checks/text-health-report.json`
and flags encoding problems.

## Repository Layout

```text
.
|-- .agents/plugins/marketplace.json
|-- .codex-plugin/plugin.json
|-- .mcp.json
|-- build.mjs
|-- bin/                      # package bin entrypoint
|-- dist/                     # bundled runtime, bootstrap, update manifest
|-- skills/                   # workflow Skills (orchestration rules)
|-- src/
|   |-- bootstrap.mjs         # dependency-free runtime update launcher source
|   |-- core/                 # scheduler, claude-runner, result normalizer, process tree
|   `-- server.mjs            # plugin MCP runtime + tool definitions
|-- schemas/                  # agent-result.schema.json, task-plan.schema.json
|-- scripts/                  # runner, smoke, text, bundle/marketplace verifiers
|-- examples/                 # mcp-config, plans, prompts
|-- docs/                     # protocol, release, verification docs
`-- package.json
```

## License
MIT © Bohaohao

# Subagent Control Protocol

**Subagent Control Protocol (SCP)** is an installable Codex plugin for controller-led agent orchestration. It bundles two things that work together: an MCP runtime that runs Claude Code CLI subagents, and an orchestrator Skill that also teaches Codex how to route named non-Claude work to host-spawned Codex workers such as `huoshan-worker`, `zhipu-worker`, or `normal-worker`. Every worker returns a structured, machine-readable result: files changed, commands run, verification evidence, risks, next steps, and token/cost evidence.

**Subagent Control Protocol（SCP）** 是一个可直接安装的 Codex 插件，用来让 Codex 作为总控编排多类 agent。它把两部分打包在一起：负责运行 Claude Code CLI 子 agent 的 MCP runtime，以及指导 Codex 何时拆分任务、何时并行、何时把非 Claude 任务路由到 `huoshan-worker`、`zhipu-worker`、`normal-worker` 等 Codex worker、如何追加 review 并整合结果的 orchestrator Skill。每个 worker 都会返回结构化、可机读的结果：改了哪些文件、跑了哪些命令、验证证据、风险、下一步、token/成本证据。

## Why It Exists

Codex is good at planning and integration, but a raw `claude -p` call is not a complete product experience for multi-agent work. SCP packages the workflow as a Codex plugin and fixes the "controller calls subagent" link:

- Codex decides task decomposition, ownership, and acceptance criteria.
- Claude Code CLI executes the bounded local task as a subagent.
- Named Codex workers execute non-`claude` branches through the Codex host when the Skill resolves aliases such as `huoshan` or `zhipu`.
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
- **MCP runtime/tool layer** — the plugin's execution layer. It manages Claude child processes, bounded concurrency, timeouts, cancellation, heartbeat health, artifact cleanup, and structured output. Exposes eight tools: blocking run, async start/collect, status/watch, cleanup, and cancel.
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
  `subagent_run_many`, `subagent_start`, `subagent_collect`,
  `subagent_status`, `subagent_watch`, `subagent_cleanup`, and
  `subagent_cancel`;
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
- **Plugin MCP runtime (`src/server.mjs`)** — owns *how* it runs: Claude child-process lifecycle, bounded concurrency enforcement, timeouts, cancellation, logging, structured output, and run archival. It exposes the runtime tools but does not decide decomposition.

两层要分开看：决策层（总控 + Skill）负责“做什么”——`todoList`、可并行分类、派发顺序、prompt、文件归属与最终决策，并发与路由在此决定，用户无需指定；插件内置 MCP runtime 负责“怎么跑”——进程生命周期、有界并发、超时、取消、日志、结构化输出与归档，只暴露工具，不参与拆分。

## Async Start / Collect Workflow

The plugin exposes both **blocking run tools** and a **non-blocking async pair**:

- **Blocking execution.** `subagent_run_task` and `subagent_run_many` start Claude work and wait for the final `{ runSummary, results }`.
- **Async start.** `subagent_start` accepts the same dependency-aware plan shape as `subagent_run_many`, starts the run in the background, and returns immediately with `runId`, `runDir`, `outputDir`, `workspace`, `status`, `startedAt`, `totalTasks`, `concurrency`, and `dryRun`. Keep `runDir` or `outputDir` with `runId`; that is the most reliable later collect handle.
- **Progress polling.** `subagent_status` reads the run directory while work is in flight and returns active processes, compact `taskEvents`, latest heartbeat/phase timestamps, and a bounded `recentEvents` window.
- **Health watch.** `subagent_watch` wraps collect/status data into controller-friendly `health`, `controllerSummary`, and `suggestedAction` fields so Codex can monitor heartbeats without reading logs. Pass `compact: true` when polling frequently to avoid echoing the full run summary/results payload.
- **Async collect.** `subagent_collect` accepts `runId` and/or `runDir` (plus optional `workspace`/`outputDir`) and returns `{ done, status, summary }`. When `done` is `false`, the payload is progress-shaped; when `done` is `true`, `summary` and `runSummary` are the final `run-summary.json`, with per-task results also available as `results` and `summary.tasks`.
- **Retention cleanup.** `subagent_cleanup` plans or executes safe cleanup of `.subagent-runs` artifact directories. `dryRun` defaults to `true`, and deletion is restricted to direct child run directories under the selected `outputDir`. Retention can be controlled with `maxAgeDays`, `maxRuns`, or `maxBytes`; failed runs are kept by default (`keepFailed: true`) and incomplete-looking runs are protected by default (`includeIncomplete: false`).

You do not start a raw server process or manage MCP plumbing yourself. The Codex plugin bundles its MCP runtime; in normal plugin use, Codex just calls these tools.

Concise controller pattern:

1. **Decompose** the task into a `todoList` of concrete, bounded steps with explicit, non-overlapping file ownership.
2. **Start parallel eligible tasks** with `subagent_start` for long-running work, or `subagent_run_many` when the controller wants to block until completion. Use `dependsOn` for ordered steps.
3. **Poll status/events** with `subagent_status`, or use `subagent_watch` when the controller needs heartbeat-derived health and a suggested action. Use `includeControllerSummary: false` or `compact: true` for high-frequency polling. Do not scan `stdout.txt`/`stderr.txt` by default.
4. **Collect the final summary** with `subagent_collect`; cross-check `filesChanged` for collisions and route any fix to the single owning agent.
5. **Run two read-only reviews** after implementation: one software-engineering review and one real-user-perspective review. Codex integrates their findings and makes the final accept/hold/ship decision.

插件同时暴露**阻塞式执行工具**和**非阻塞异步工具对**：

- **阻塞执行。** `subagent_run_task` 与 `subagent_run_many` 会启动 Claude 任务，并等待最终 `{ runSummary, results }`。
- **异步启动。** `subagent_start` 接收与 `subagent_run_many` 相同的依赖感知计划，在后台启动运行，并立刻返回 `runId`、`runDir`、`outputDir`、`workspace`、`status`、`startedAt`、`totalTasks`、`concurrency`、`dryRun`。请保留 `runDir`，或同时保留 `outputDir` 与 `runId`，这是后续 collect 最稳的定位信息。
- **进度轮询。** `subagent_status` 可在任务运行中读取运行目录，返回活动进程、紧凑的 `taskEvents`、最新心跳/阶段时间，以及有界的 `recentEvents` 窗口。
- **异步收集。** `subagent_collect` 接收 `runId` 和/或 `runDir`（也可带 `workspace`/`outputDir`），返回 `{ done, status, summary }`。`done` 为 `false` 时是进度态；`done` 为 `true` 时，`summary` 与 `runSummary` 就是最终 `run-summary.json`，每个子任务结果也会出现在 `results` 与 `summary.tasks`。

你无需自行启动原始 server 进程或管理 MCP 管线。Codex 插件已经内置 MCP runtime，正常使用时 Codex 直接调用这些工具即可。

总控精简范式：

1. **拆解** 任务为 `todoList`——具体、有界、且文件归属互不重叠的步骤。
2. **启动可并行任务**——长任务优先用 `subagent_start`；如果总控希望阻塞等待完成，则用 `subagent_run_many`。有依赖的步骤用 `dependsOn` 排序。
3. **轮询状态/事件**——用 `subagent_status` 读取最新心跳/阶段与 `recentEvents`，而非扫描 `stdout.txt`/`stderr.txt`。
4. **收集最终摘要**——用 `subagent_collect` 获取最终 summary；交叉比对 `filesChanged` 检查冲突，把修复定向给失败文件的唯一所有者。
5. **跑两个只读评审**——实现完成后，派发一个“软件工程评审”子 agent 和一个“真实用户视角评审”子 agent。总控整合其结论后做最终的接受/搁置/发布决策。

## Mixed Claude + Codex Worker Workflow

SCP's default model is "Codex controller + Claude subagents." You can also mix
**Claude workers** and **Codex workers** in the same plan. The two channels stay
separate, and the controller is the only thing that ties them together.

### Two channels, one controller

- **Claude channel.** Claude subagents run through SCP's MCP runtime
  (`subagent_run_task` / `subagent_run_many` / `subagent_start`). Their results
  come back as the normal MCP envelope: `runSummary`, `results`, and
  `measuredUsageSummary`. Nothing changes on this path when you add Codex workers.
- **Codex worker channel.** Codex workers are spawned by the Codex *host* itself
  via `multi_agent_v1.spawn_agent` — not by SCP's Node MCP runtime. SCP does not
  spawn Codex workers directly. The controller waits on each worker with
  `wait_agent` and reads its final message as the result.
- **One controller, one `todoList`, one `dispatchLedger`.** The Codex controller
  owns a single `todoList` (what to do, in what order) and a single
  `dispatchLedger` (which todo went to which channel/worker, and its status).
  Both channels draw from the same list; the ledger is how the controller
  reconciles Claude results and Codex worker results side by side.

### Natural prompts

You can describe the split in plain language and let the controller route it:

- **中文:**
  > 任务一让 claude 并行做，任务二派三个 huoshan 和三个 zhipu 并行做。
- **English:**
  > Task one: have Claude do it in parallel. Task two: dispatch three huoshan and three zhipu workers in parallel.

`huoshan` and `zhipu` are worker aliases the controller resolves before dispatch
(see alias resolution below). The controller records each dispatch in the
`dispatchLedger` so it can tell, later, which channel and worker a result came
from.

### Worker alias resolution & fallback

When you name a Codex worker, the controller resolves it before spawning:

- `huoshan` → `huoshan-worker`
- `zhipu` → `zhipu-worker`
- An exact `xxx-worker` name is used as-is.
- A missing worker falls back to `normal-worker`.
- If `normal-worker` is also missing, that branch is **blocked** — the controller
  does not run it, and records the block in the ledger.
- The controller **never** silently falls back to the Codex default agent. A
  worker that cannot be resolved blocks rather than running as something else.

### Reading results from both channels

- **Claude results** arrive as the MCP envelope (`runSummary`, `results`,
  `measuredUsageSummary`) — the same shape SCP already uses.
- **Codex worker results** arrive as the `wait_agent` final message. The
  controller prompts each Codex worker to return JSON compatible with the SCP
  result contract (the same base fields Claude returns) plus worker identity:
  `workerRuntime: "codex"`, `workerType` (for example `huoshan-worker`),
  optional `workerAlias`, and optional `fallbackApplied`. If a worker's final
  message is missing required fields, the controller may call `send_input`
  **once** on that worker to request the missing fields, then accept whatever it
  returns as final. The controller does not retry beyond that one follow-up.

### Codex worker 429 auto-continue

This recovery rule applies **only to Codex workers**; the Claude/SCP runner path
is unchanged.

- When a Codex worker's `wait_agent` final status or final message clearly
  indicates a 429 / rate-limit condition, the controller sends `继续` to that
  worker and retries collection.
- The controller makes at most **3** auto-continue attempts per worker; after the
  third it accepts the worker's last reply as final.
- This is a **separate** mechanism from the one-time `send_input` follow-up used
  to repair missing or invalid structured-result fields. The two are independent
  and each keeps its own limit.
- If the final status or final message is ambiguous, the controller does not
  auto-continue.
- Support is **final-message / final-status based only**. SCP does not promise
  mid-run 429 interception; a 429 that does not surface in the `wait_agent` final
  status or final message is not auto-continued.
- The controller's final summary states whether auto-continue happened for a
  worker and whether it recovered.

### Compatibility

This mixed model is additive:

- The Claude runner path is unchanged — Claude subagents still go through SCP's
  MCP runtime exactly as before.
- SCP's Node MCP runtime does **not** spawn Codex workers. Codex workers are
  host-spawned (`multi_agent_v1.spawn_agent`); SCP only handles the Claude
  channel and the shared result contract.

混合 Claude + Codex worker 的工作流是叠加式的：Claude 子 agent 仍走 SCP 的 MCP runtime，结果以 MCP 信封（`runSummary`/`results`/`measuredUsageSummary`）返回，路径不变；Codex worker 由 Codex 宿主通过 `multi_agent_v1.spawn_agent` 派生，SCP 的 Node MCP runtime 不直接派生 Codex worker。总控持有一份 `todoList` 和一份 `dispatchLedger`，两条通道都从同一份列表取活，账本用来对账两边结果。worker 别名解析：`huoshan`→`huoshan-worker`、`zhipu`→`zhipu-worker`，精确的 `xxx-worker` 原样使用；缺失 worker 回退到 `normal-worker`，若 `normal-worker` 也缺失则该分支阻塞，绝不回退到 Codex 默认 agent。Codex worker 结果以 `wait_agent` 终态消息返回，需提示其返回与 Claude 兼容的 JSON；缺字段时总控可用 `send_input` 再追问一次。Codex worker 遇到 429/限流时，总控向其发送 `继续` 并重试收集，每 worker 最多 3 次；若终态状态或消息不明确，则不会自动继续（仅基于 `wait_agent` 终态消息/状态判定，与补字段的 `send_input` 一次性追问相互独立，不承诺运行中拦截）；最终摘要需说明是否触发自动继续及是否恢复。

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
| `subagent_start` | Start a dependency-aware plan in the background and return immediately with `runId`/`runDir`; use for long-running async orchestration. |
| `subagent_collect` | Collect interim progress or the final `run-summary.json` for a run started by `subagent_start`; returns `{ done, status, summary }`. |
| `subagent_status` | Read one `run-summary.json` (mode `single`) or list recent runs from an output dir (mode `list`); both include the active-process list. In single mode it also surfaces event-aware fields when present — latest heartbeat/phase, a per-task `taskEvents` summary, and a bounded `recentEvents` window (pass `recentEventsLimit` to cap it). Prefer this over reading raw `stdout.txt`/`stderr.txt`. |
| `subagent_watch` | Read controller-friendly run health without starting new work. Returns collect/status data plus `health`, `controllerSummary`, and `suggestedAction` for stalled/slow heartbeat handling. Use `compact: true` for cheap polling. |
| `subagent_cleanup` | Plan or execute retention cleanup for run artifact directories. Defaults to dry-run mode; only direct child run directories under `outputDir` are eligible for deletion. Supports `maxAgeDays`, `maxRuns`, `maxBytes`, `keepFailed`, and `includeIncomplete`. |
| `subagent_cancel` | Best-effort cancellation for active Claude child processes in this server process. Requires `runId`. |

Every tool returns a shared envelope: `{ ok: true, ...payload }` on success, or `{ ok: false, error: { code, message, stack? } }` (with `isError: true`) on failure. Blocking run tools include `runSummary` in `structuredContent`; async start returns a run locator, and async collect returns progress or the final summary.

## Result Contract

Every Claude subagent is asked to return JSON matching `schemas/agent-result.schema.json`.
Codex worker final messages use the same base contract, with optional worker
identity fields when available:

- `status` — `completed` | `partial` | `blocked` | `failed`
- `summary` — factual outcome
- `filesChanged` — files changed and why
- `commandsRun` — commands with pass/fail/skipped state
- `verification` — checks and evidence
- `risks` — remaining risks with severity
- `nextSteps` — concrete follow-up actions
- `tokenUsageSummary` — **required, always.** A Claude-authored note on whether exact token usage was visible; never fabricate exact counts.
- `metrics` — optional token/cost numbers when visible.
- `workerRuntime` — optional, `claude` or `codex`; Codex workers should set `codex`.
- `workerType` — optional resolved worker type, e.g. `huoshan-worker`, `zhipu-worker`, or `normal-worker`.
- `workerAlias` — optional original alias or nickname, e.g. `huoshan`.
- `fallbackApplied` — optional boolean, true when alias resolution used a fallback worker.

The runner normalizes common variants (`files_changed`, `verifications`, `status: "passed"`) into the official shape, and repairs common Claude output envelopes such as fenced JSON blocks, prose-wrapped JSON, and `{ type: "result", result: "..." }`. The controller also records measured usage from the Claude CLI envelope as `usage` and `measuredUsageSummary` when available — prefer these over the subagent's self-report for actual token/cost.

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

`tasks/<id>/events.jsonl` is an append-only log of structured lifecycle events. The runtime writes task/process start/exit events and a periodic runtime `heartbeat` while the Claude process is active; the Claude subprocess is also asked to emit `phase_started`, `checkpoint`, `blocked`, and `command_started`/`command_finished`. It is a structured event stream, **not** a capture of the subagent's full `stdout`/`stderr`. Read it (or, better, ask `subagent_status` for the derived `taskEvents`/`recentEvents` summary) to track live progress, latest phase, and recent heartbeats without touching process logs.

`timeoutMs` is an **idle timeout**, not an absolute wall-clock deadline. A Claude
subagent is expected to keep writing subagent-owned events (especially
`heartbeat` or `checkpoint`) during long work. If no subagent-owned event is
observed for `timeoutMs`, the runner treats the task as stalled and stops it.
Runtime-owned heartbeats (`source: "runtime"`) prove the process is alive, but
they do **not** reset the subagent idle timeout by themselves.

Event entries are compact JSON objects. Common fields are:

- `type` — event type, such as `task_started`, `phase_started`, `heartbeat`, `checkpoint`, `blocked`, `command_started`, `command_finished`, `process_exited`, or `task_completed`.
- `timestamp` — ISO timestamp.
- `taskId` — subagent task id.
- `message` / `summary` / `reason` — short human-readable context.
- `phase` — current phase for `phase_started`.
- `label` / `command` — short command label for command events; do not include full command output.
- `status` / `exitCode` / `durationMs` — small terminal or command outcome fields when relevant.
- `sequence` — monotonic heartbeat sequence number when runtime or subagent emits periodic heartbeats.
- `progress` / `etaSeconds` — compact progress hints when available.
- `severity` / `needsController` — escalation hints for blocked or unusual states.

The event log is best-effort observability. Both the runtime and the Claude subprocess may append to it, so malformed or interleaved lines are ignored by `subagent_status`; full stdout/stderr remain artifact-only. `subagent_watch` turns the same event data into a compact health view for controller monitoring.

Read order for controllers:

1. `run-summary.json` — overall run status.
2. `tasks/<id>/result.json` — one normalized task result.
3. `tasks/<id>/events.jsonl` (or `subagent_status`) — latest heartbeat/phase and recent events for progress tracking.
4. `subagent_watch` — controller health, stalled/slow task hints, and suggested next action for long-running async work.
5. `tasks/<id>/raw-output.json` — only when debugging Claude's original envelope.
6. `stdout.txt` / `stderr.txt` — artifact-only, for process-level diagnosis. Do not read these by default; prefer `subagent_status`, `subagent_watch`, and `events.jsonl` for observability.

## Desktop status contract & integration boundary

SCP is the **single status source**. A desktop monitor app, if you use one, is a
**read-only observer** — it watches runs, it does not drive them. The desktop
project is **separate** from this repository; SCP does not ship the desktop app,
and the desktop app is not part of this plugin bundle.

SCP 是唯一的**状态来源**。桌面监控应用（如有）只是**只读观察者**——它观察运行，
不驱动运行。桌面项目是**独立**于本仓库的；SCP 不附带桌面应用，桌面应用也不属于本插件包。

### Status source vs. observer

- **SCP owns state.** Decomposition, dispatch, process lifecycle, heartbeats,
  cancellation, and the final accept/ship decision all stay inside SCP and the
  Codex controller. Only the controller may dispatch or cancel work.
- **The desktop owns display.** It renders run/task status, health, heartbeats,
  and events for a human. It never dispatches subagents, never cancels runs, and
  never writes into SCP's run artifacts. Cancellation stays an MCP-layer
  operation (`subagent_cancel`); the desktop can *show* a stalled run but must
  not kill processes itself.

### Stable mirror concept

SCP already writes stable, per-run artifacts under
`<workspace>/.subagent-runs/<runId>/`:

```text
.subagent-runs/<runId>/
  run-summary.json     # overall run status, tasks, health hints
  events.jsonl         # append-only lifecycle + heartbeat event stream
  tasks/<id>/
    result.json        # normalized per-task result
    events.jsonl       # per-task event stream
```

This artifact directory remains the source of truth. `subagent_desktop_status`
can also write an optional stable `status.json` mirror to
`SCP_STATUS_MIRROR_DIR` (or a per-user default) so external desktop widgets do
not have to chase versioned plugin cache paths.

### Desktop status schema (`scp.run-view/v1`)

The desktop view model is defined by `schemas/desktop-status.schema.json` and
returned by both `subagent_desktop_status` and the status bridge. The
versioning anchor is the top-level `schema` field (`scp.run-view/v1`), not the
file path: consumers must check that field and tolerate additional fields and
`null` gaps. Nested view tags include `scp.task-view/v1` (per task),
`scp.event-view/v1` (per recent event), `scp.token-evidence/v1` (measured usage,
`measured: false` when no numbers exist), `scp.status-mirror/v1` (the
`status.json` envelope), and `scp.bridge-discovery/v1` (`bridge.json`). The
model has `mode: "run"` (one run) and `mode: "list"` (runs overview), plus
UI-friendly fields a widget can render directly: `displayStatus`, `statusTone`,
`progressHint`, `health`, `counts`, `activeTaskCount`, `lastUsefulEventAt`, and
`stalenessMs`.

Default privacy posture: raw prompts, `stdout`/`stderr`, env, and full command
bodies are never placed in the view in the first place. Commands and
verification snippets are reduced to a display-safe `label` (program name, with
leading `ENV=value` stripped) plus a redacted, truncated snippet that masks
credential-shaped `<hint>=value` pairs and `Bearer <token>`. **This is a
best-effort display filter, not a security boundary** — treat the view as
display-only.

桌面视图模型由 `schemas/desktop-status.schema.json` 定义，版本锚点是顶层 `schema`
字段（`scp.run-view/v1`），消费者须据此判断版本并容忍多余字段与 `null` 缺口。默认隐私策略：原始 prompt、stdout/stderr、env 与完整命令体不会进入视图；命令/验证片段会被裁成显示安全的小段并遮蔽凭据形对的键值——这只是尽力而为的显示过滤，并非安全边界。

### Status bridge contract

> **Status: implemented, opt-in.** SCP ships an optional read-only localhost
> status bridge. It is disabled by default and starts only when the controller
> calls `subagent_status_bridge` with `action: "start"`.

Read-only localhost endpoints (all `GET`, observer-side):

| Route | Mirrors | Returns |
| --- | --- | --- |
| `GET /health` | `subagent_desktop_status` | bridge health, counts, active tasks |
| `GET /runs` | `subagent_desktop_status` list mode | recent runs + active-process list |
| `GET /run/:runId` | `subagent_desktop_status` run mode | one run view model |
| `GET /events` | `recentEvents` window | bounded event tail |
| `GET /events/stream` | periodic snapshot stream | SSE `snapshot` events |

Contract rules for any bridge implementation:

- **Loopback-only by default.** The bridge has no authentication, so
  `subagent_status_bridge` rejects non-loopback hosts unless
  `allowNonLoopback: true` is set explicitly.
- **Read-only.** No `POST`/`PUT`/`DELETE`. The bridge never dispatches, cancels,
  or mutates run state. Mutation stays on the MCP/tool layer.
- **Bound the event tail.** Mirror the `recentEventsLimit` behavior of
  `subagent_status`; never stream a full `events.jsonl` to the desktop.
- **Tolerate partial state.** A run directory may be mid-write or incomplete.
  Return an explicit `incomplete_or_unreadable` status rather than failing.
- **No secrets.** Never surface `stdout.txt`/`stderr.txt` or raw prompt bodies by
  default; the bridge exposes status/health/events, not full process logs.

### Bridge discovery (`bridge.json`)

When the bridge starts, SCP writes a small `bridge.json` discovery file (schema
`scp.bridge-discovery/v1`) to a stable per-user location so a widget can find
the bridge's `host`/`port` without scraping ports. It carries `host`, `port`,
`startedAt`, `updatedAt`, `pid`, and optional `workspace`/`outputDir` — no
secrets. It is written atomically on start and removed on stop; a missing or
corrupt file reads back as `null`. Directory resolution (first non-empty wins):
an explicit `discoveryDir` option; the `SCP_BRIDGE_DISCOVERY_DIR` env var; a
stable per-user dir (`<homedir>/.scp/bridge`, or `%LOCALAPPDATA%\scp\bridge` on
Windows); or the run `outputDir`/`taskDir` as a fallback. A widget reads
`bridge.json`, then connects to `http://<host>:<port>`; if the file is absent
the bridge may simply not be running — retry rather than error.

### Incremental event consumption

`GET /events` supports cursor-based incremental reads: `afterSequence` (integer
cursor — events with `sequence` greater than this), `since` (ISO timestamp
lower bound), and `limit` (max events). The tail is always bounded — the view
keeps at most a small `recentEvents` window (newest last), mirroring
`subagent_status`'s `recentEventsLimit`; the bridge never streams a full
`events.jsonl`. `afterSequence` only applies to events with a numeric
`sequence`; null-sequence events are omitted from cursor responses and remain
visible through fresh snapshots or `since` polling. If a widget's cursor falls
outside the bounded tail and returns no events, keep the last rendered snapshot
and refresh from `/run/:runId` or `/runs`. `GET /events/stream` is an SSE channel that sends a
`: connected` comment on connect, then periodic `snapshot` events, with a
`: ping` keep-alive roughly every 15 seconds so a dead bridge is detectable
even without event traffic. The stream is observer-only.

### Heartbeat semantics for observers

The runtime writes a periodic `heartbeat` event to `events.jsonl` (with a
monotonic `sequence`) while a Claude child process is active; the Claude
subprocess is also asked to emit `phase_started`, `checkpoint`, `blocked`, and
`command_started`/`command_finished`. For an observer:

- A **fresh heartbeat** means the run is alive; show the latest `phase` and
  `sequence`.
- A **stale or missing heartbeat** means "unknown / possibly stalled" — display
  it as such, but **do not** infer death or kill the process. The controller
  decides cancellation via `subagent_cancel` / `subagent_watch`'s
  `suggestedAction`; the desktop only surfaces the signal.
- Heartbeats are best-effort. Malformed or interleaved event lines are ignored;
  a gap in `sequence` is informational, not an error.

### Read-only desktop behavior (hard rule)

The desktop app and any status bridge must be **read-only** with respect to SCP:

- Never write into `.subagent-runs/` or any run directory.
- Never call dispatch/cancel MCP tools on the controller's behalf.
- Treat the mirror as immutable artifacts produced by SCP; the desktop is a
  viewer, not a participant.

桌面与状态桥接对 SCP 必须**只读**：不得写入 `.subagent-runs/`；不得代总控调用派发/取消工具；
镜像目录是 SCP 产出的不可变产物，桌面只是查看者，不参与执行。

## Safety Notes

- Do not commit API keys, Claude tokens, browser profiles, or run logs.
- Use private repositories when prompts may contain proprietary project context.
- Parallelize read-only work (review, research, verification) first.
- Keep implementation single-writer with explicit, non-overlapping file ownership; never let two subagents edit the same file concurrently.
- Use `dryRun: true` to validate task decomposition or MCP wiring before a real run.
- Treat `permissionMode: "bypassPermissions"` and `"auto"` as privileged modes; prefer isolated workspaces for delegated tasks and never use them on shared trees.
- Use `subagent_cleanup` in dry-run mode first when pruning run artifacts; execute cleanup only after checking the returned plan.
- When reclaiming space, remember that `keepFailed` defaults to `true` and `includeIncomplete` defaults to `false`; these defaults protect diagnostic runs and in-progress-looking runs.
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

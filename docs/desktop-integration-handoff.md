# SCP Desktop Integration Handoff

面向桌面端组件的对接文档。本文只描述桌面端应该依赖的公开契约，不要求桌面端读取 SCP 内部源码、run registry 或 scheduler。

## 1. 集成目标

桌面端组件是 **只读观察者**：

- 展示 Codex 通过 SCP 派发的 Claude subagent 工作状态。
- 展示运行列表、单个 run 的任务进度、健康状态、心跳、最近事件和 token 证据。
- 不创建任务、不取消任务、不写 `.subagent-runs/`、不修改任何 run artifact。

SCP 是唯一状态源。桌面端只消费以下三个稳定入口：

1. `bridge.json` 发现文件，用于找到本机 HTTP/SSE bridge。
2. localhost HTTP/SSE bridge，用于实时读取状态。
3. `scp.run-view/v1` 视图模型，用于直接渲染 UI。

## 2. 当前可用能力

SCP 插件已提供两个 MCP 工具：

- `subagent_desktop_status`：返回桌面端视图模型，可选读写 `status.json` 镜像。
- `subagent_status_bridge`：启动、停止、重启、查看本机只读 HTTP/SSE bridge。

HTTP/SSE bridge 默认不启动。由 Codex/SCP 总控在需要时调用 MCP 工具启动，桌面端通过 `bridge.json` 发现它。

## 3. 推荐启动流程

由 Codex/SCP 总控调用：

```json
{
  "action": "start",
  "host": "127.0.0.1",
  "port": 0,
  "workspace": "D:\\private\\agent-orchestration-kit",
  "outputDir": "D:\\private\\agent-orchestration-kit\\.subagent-runs",
  "intervalMs": 5000,
  "recentEventsLimit": 50
}
```

说明：

- `host` 必须默认保持 `127.0.0.1`。bridge 没有鉴权，非 loopback 绑定必须显式 `allowNonLoopback: true`，桌面端集成不应使用它。
- `port: 0` 表示让系统选择空闲端口，端口会写入 `bridge.json`。
- `intervalMs` 是 SSE snapshot 推送间隔，建议 3000 到 5000ms。
- `recentEventsLimit` 是最近事件窗口大小，建议桌面端 50 起步。

启动成功后 MCP 返回形如：

```json
{
  "ok": true,
  "action": "start",
  "running": true,
  "host": "127.0.0.1",
  "port": 55777,
  "intervalMs": 5000,
  "discovery": {
    "schemaVersion": 1,
    "schema": "scp.bridge-discovery/v1",
    "host": "127.0.0.1",
    "port": 55777,
    "startedAt": "2026-06-25T09:49:13.000Z",
    "updatedAt": "2026-06-25T09:49:13.000Z",
    "pid": 12345,
    "workspace": "D:\\private\\agent-orchestration-kit",
    "outputDir": "D:\\private\\agent-orchestration-kit\\.subagent-runs"
  }
}
```

## 4. 桌面端发现 bridge

桌面端启动后先读取发现文件：

Windows 默认路径：

```text
%LOCALAPPDATA%\scp\bridge\bridge.json
```

也可以通过环境变量覆盖：

```text
SCP_BRIDGE_DISCOVERY_DIR=<custom-dir>
```

最终文件名固定为：

```text
<discovery-dir>\bridge.json
```

`bridge.json` 字段：

```json
{
  "schemaVersion": 1,
  "schema": "scp.bridge-discovery/v1",
  "host": "127.0.0.1",
  "port": 55777,
  "startedAt": "2026-06-25T09:49:13.000Z",
  "updatedAt": "2026-06-25T09:49:13.000Z",
  "pid": 12345,
  "workspace": "D:\\private\\agent-orchestration-kit",
  "outputDir": "D:\\private\\agent-orchestration-kit\\.subagent-runs"
}
```

桌面端行为建议：

- 文件不存在：显示 “SCP bridge 未运行”，每 2 到 5 秒重试。
- 文件存在：连接 `http://<host>:<port>/health` 验证可用。
- 连接失败：不要报崩溃，认为 bridge 未运行或已重启，继续重试读取 `bridge.json`。
- 不要只信任旧端口。bridge 重启后端口可能变化。
- 可以用 `pid` 做辅助展示，但不要由桌面端杀进程。

## 5. HTTP endpoints

base URL 来自 discovery：

```text
http://127.0.0.1:<port>
```

### 5.1 GET /health

用于 bridge 存活和概览健康状态。

```http
GET /health
```

响应：

```json
{
  "ok": true,
  "schema": "scp.bridge-health/v1",
  "timestamp": "2026-06-25T09:49:13.000Z",
  "health": {
    "level": "running",
    "running": true,
    "activeCount": 2,
    "staleCount": 0
  },
  "counts": {
    "total": 5,
    "completed": 2,
    "partial": 0,
    "failed": 0
  },
  "activeTasks": []
}
```

`health.level` 取值：

- `ok`：已完成或无异常。
- `running`：有任务运行中。
- `warning`：有阻塞或心跳 stale。
- `error`：失败或超时。
- `unknown`：没有足够信息。

### 5.2 GET /runs

获取最近 run 列表，返回 `scp.run-view/v1` 的 list mode。

```http
GET /runs
```

响应重点：

```json
{
  "source": "list",
  "schema": "scp.run-view/v1",
  "redacted": true,
  "view": {
    "schema": "scp.run-view/v1",
    "mode": "list",
    "status": "list",
    "displayStatus": "List",
    "statusTone": "active",
    "progressHint": "3 runs, 1 active",
    "activeTaskCount": 1,
    "health": {
      "level": "running",
      "running": true,
      "activeCount": 1
    },
    "runs": [
      {
        "runId": "2026-06-25T09-29-50-967Z",
        "status": "completed",
        "startedAt": "2026-06-25T09:29:50.967Z",
        "endedAt": "2026-06-25T09:42:36.365Z",
        "totalTasks": 2,
        "completedTasks": 1,
        "failedTasks": 0
      }
    ],
    "activeTasks": []
  }
}
```

桌面端首页建议使用 `/runs` 作为主数据源。

### 5.3 GET /run/:runId

获取单个 run 详情。

```http
GET /run/2026-06-25T09-29-50-967Z
```

响应：

```json
{
  "source": "run",
  "schema": "scp.run-view/v1",
  "redacted": true,
  "view": {
    "schema": "scp.run-view/v1",
    "mode": "run",
    "runId": "2026-06-25T09-29-50-967Z",
    "status": "completed",
    "phase": "final",
    "displayStatus": "Completed",
    "statusTone": "positive",
    "progressHint": "2/2 tasks",
    "activeTaskCount": 0,
    "lastUsefulEventAt": "2026-06-25T09:42:36.365Z",
    "stalenessMs": 1500,
    "counts": {
      "total": 2,
      "completed": 1,
      "partial": 1,
      "failed": 0
    },
    "health": {
      "level": "ok"
    },
    "tasks": [],
    "recentEvents": [],
    "tokenEvidence": {
      "schema": "scp.token-evidence/v1",
      "measured": true,
      "totals": {}
    },
    "artifacts": {}
  }
}
```

桌面端详情页建议直接渲染 `view`，不要读取 raw artifacts。

### 5.4 GET /events

获取有界最近事件窗口，适合轮询增量事件。

```http
GET /events?runId=2026-06-25T09-29-50-967Z&limit=50
GET /events?runId=2026-06-25T09-29-50-967Z&afterSequence=120&limit=50
GET /events?runId=2026-06-25T09-29-50-967Z&since=2026-06-25T09%3A42%3A00.000Z&limit=50
```

响应：

```json
{
  "ok": true,
  "schema": "scp.bridge-events/v1",
  "runId": "2026-06-25T09-29-50-967Z",
  "events": [
    {
      "schema": "scp.event-view/v1",
      "type": "heartbeat",
      "timestamp": "2026-06-25T09:42:30.000Z",
      "runId": "2026-06-25T09-29-50-967Z",
      "taskId": "T1",
      "phase": "in_progress",
      "sequence": 121,
      "message": "heartbeat"
    }
  ]
}
```

重要边界：

- `/events` 只返回有界窗口，不返回完整 `events.jsonl`。
- `afterSequence` 只匹配带数字 `sequence` 的事件。
- `sequence: null` 的事件不会出现在 `afterSequence` 增量结果里，但会出现在新 snapshot 或 `since` 查询可见范围内。
- 如果 cursor 太旧导致结果为空，桌面端应保留上一次 UI，并刷新 `/run/:runId` 或 `/runs`。

### 5.5 GET /events/stream

语义补充（`/events` 与 `recentEvents`）：

- `recentEvents`（`scp.run-view/v1` 顶层字段）是 **bounded overview window**，用于 run snapshot 的“最近发生了什么”概览。
- `/events` 是 **bounded incremental retrieval**，用于桌面端按 cursor 拉增量；它不是 raw event log 导出接口。
- `recentEvents[].sequence` 在桌面端桥接层表示 **run-global monotonic cursor**：它作用于“合并后的 run 事件流”，不是 task-local heartbeat 序号。

SSE 实时流。bridge 会先发一个注释：

```text
: connected
```

随后发送 `data:` JSON 帧。当前实现不使用命名 `event:` 字段，客户端按 `message`/`data` 读取即可。

```http
GET /events/stream
```

数据帧：

```text
data: {"type":"snapshot","timestamp":"2026-06-25T09:49:13.000Z","view":{"schema":"scp.run-view/v1","mode":"list"}}
```

keep-alive：

```text
: ping
```

桌面端策略：

- 优先用 SSE 更新 UI。
- SSE 断开后退回 `/health` + `/runs` 轮询。
- 重连前重新读取 `bridge.json`，因为端口可能已变化。
- 连接数应控制在 1 个主连接。多窗口 UI 应在桌面端内部 fan-out，不要每个窗口都连一次 bridge。

## 6. scp.run-view/v1 渲染字段

桌面端应优先渲染这些字段：

| 字段 | 用途 |
| --- | --- |
| `schema` | 必须为 `scp.run-view/v1` |
| `mode` | `list` 或 `run` |
| `status` | 机器状态 |
| `displayStatus` | 直接给 UI 展示的人类状态 |
| `statusTone` | UI 色调建议 |
| `progressHint` | 一行进度摘要 |
| `activeTaskCount` | 运行中的子任务数 |
| `lastUsefulEventAt` | 最近有效进展时间 |
| `stalenessMs` | 距离最近进展的毫秒数 |
| `staleThresholdMs` | 当前 snapshot 使用的 stale 判定阈值（毫秒） |
| `health.level` | 总体健康状态 |
| `counts` | 任务结果统计 |
| `runs[]` | list mode 的 run 列表 |
| `tasks[]` | run mode 的任务详情 |
| `activeTasks[]` | 进行中的任务视图，遵循 `activeTaskView` 契约，稳定排序 |
| `recentEvents[]` | 有界事件尾巴 |
| `tokenEvidence` | 实测 token/cost 证据 |

状态枚举：

```text
running | completed | failed | blocked | cancelled | partial | skipped | list | unknown
```

`counts` 语义补充：

- `running` / `pending` 是进行态统计，不属于 `partial`。
- `partial` 只表示“部分完成 / 部分可信的终态”。
- 桌面端不得把 `running`、`pending` 当成 `partial` 去做展示文案或健康推断。

色调枚举：

```text
positive | warning | negative | neutral | active
```

## 7. 隐私和安全边界

桌面端默认拿到的是 redacted view：

- 不包含原始 prompt。
- 不包含完整 stdout/stderr。
- 不包含 env。
- 不包含完整命令体。
- 命令和验证片段只保留显示安全的 label/snippet，并做凭据形态脱敏。

注意：这是显示层过滤，不是安全沙箱。桌面端仍然应避免把 view 原样上传到第三方服务。

bridge 安全边界：

- 只绑定 `127.0.0.1`。
- 无鉴权，不允许暴露到局域网。
- 只有 `GET`，无写接口。
- 不支持 dispatch/cancel/cleanup。取消任务必须由 Codex/SCP 总控通过 MCP 工具执行。

## 8. 桌面端错误处理

推荐 UI 状态：

| 场景 | 桌面端表现 |
| --- | --- |
| 找不到 `bridge.json` | 显示未连接，后台重试 |
| `/health` 连接失败 | 显示 bridge 离线，重新读 discovery |
| HTTP 501 | 当前 endpoint provider 未配置，降级隐藏对应区域 |
| HTTP 502 | provider 读取失败，保留旧 snapshot 并重试 |
| SSE 断开 | 切换到轮询，并尝试重连 |
| `schema` 不匹配 | 显示版本不兼容提示，不渲染未知结构 |
| `health.level=warning` | 黄色提醒，不自动杀进程 |
| `health.level=error` | 红色提醒，展示失败摘要和 runId |

## 9. Electron/Tauri 接入建议

如果桌面端是 Electron 或 Tauri：

- 推荐在 main/backend 层读取 `bridge.json` 并请求 localhost bridge。
- renderer 层只接收 main/backend 转发后的 view model。
- 不要从 renderer 直接读取磁盘和调用危险系统 API。
- 当前 bridge 没有 CORS header；如果 renderer 直接 `fetch` localhost 遇到 CORS 限制，应由 main/backend 代理。

## 10. 最小 TypeScript 类型

```ts
export type ScpStatusTone =
  | 'positive'
  | 'warning'
  | 'negative'
  | 'neutral'
  | 'active'

export type ScpRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'partial'
  | 'skipped'
  | 'list'
  | 'unknown'

export interface ScpBridgeDiscovery {
  schemaVersion: 1
  schema: 'scp.bridge-discovery/v1'
  host: string
  port: number
  startedAt: string
  updatedAt: string
  pid?: number
  workspace?: string
  outputDir?: string
}

export interface ScpHealth {
  level?: 'ok' | 'running' | 'warning' | 'error' | 'unknown'
  running?: boolean
  activeCount?: number
  staleCount?: number
  failedCount?: number
  blockedCount?: number
}

export type ScpObservability = 'live' | 'summary-only'

export interface ScpActiveTaskView {
  taskId?: string | null
  title?: string | null
  pid?: number | null
  startedAt?: string | null
  lastEventAt?: string | null
  lastHeartbeatAt?: string | null
  phase?: string | null
  eventLogPath?: string | null
  runtime?: 'claude' | 'codex' | null
  dispatcher?: 'scp-claude' | 'codex-worker' | null
  workerType?: string | null
  workerAlias?: string | null
  fallbackApplied?: boolean | null
  observability?: ScpObservability | null
}

export interface ScpEventView {
  schema: 'scp.event-view/v1'
  type?: string | null
  timestamp?: string | null
  runId?: string | null
  taskId?: string | null
  phase?: string | null
  label?: string | null
  summary?: string | null
  message?: string | null
  reason?: string | null
  status?: string | null
  exitCode?: number | null
  sequence?: number | null
  durationMs?: number
}

export interface ScpRunView {
  schema: 'scp.run-view/v1'
  mode?: 'run' | 'list' | null
  runId?: string | null
  runDir?: string | null
  status?: ScpRunStatus | null
  phase?: 'in_progress' | 'final' | 'list' | null
  displayStatus?: string | null
  statusTone?: ScpStatusTone | null
  progressHint?: string | null
  activeTaskCount: number
  lastUsefulEventAt?: string | null
  stalenessMs?: number | null
  staleThresholdMs?: number | null
  counts?: Record<string, number>
  health?: ScpHealth
  runs?: Array<Record<string, unknown>>
  tasks?: Array<Record<string, unknown>>
  activeTasks?: ScpActiveTaskView[]
  recentEvents?: ScpEventView[]
  tokenEvidence?: Record<string, unknown>
  artifacts?: Record<string, unknown>
}
```

## 11. 最小客户端伪代码

```ts
async function connectScpDesktop() {
  const discovery = await readBridgeDiscovery()
  if (!discovery) return { connected: false, reason: 'bridge_not_running' }

  const baseUrl = `http://${discovery.host}:${discovery.port}`
  const health = await fetchJson(`${baseUrl}/health`)
  if (!health?.ok) return { connected: false, reason: 'health_failed' }

  const runs = await fetchJson(`${baseUrl}/runs`)
  assertRunView(runs.view)

  const sse = new EventSource(`${baseUrl}/events/stream`)
  sse.onmessage = (event) => {
    const payload = JSON.parse(event.data)
    if (payload.type === 'snapshot' && payload.view?.schema === 'scp.run-view/v1') {
      render(payload.view)
    }
  }
  sse.onerror = () => {
    sse.close()
    startPollingFallback(baseUrl)
  }

  return { connected: true, baseUrl, health, runs }
}
```

## 12. 桌面端验收清单

- 能读取 `%LOCALAPPDATA%\scp\bridge\bridge.json`。
- 能在 bridge 未启动时显示离线并自动重试。
- 能通过 `/health` 展示 bridge 存活状态。
- 能通过 `/runs` 展示 run 列表。
- 能点击 runId 后通过 `/run/:runId` 展示详情。
- 能通过 `/events/stream` 实时更新状态。
- SSE 断开后能降级为 `/health` + `/runs` 轮询。
- 能处理 bridge 重启和端口变化。
- 不调用任何 SCP 写操作。
- 不写 `.subagent-runs/`。
- 不展示 raw prompt/stdout/stderr/env。
- 能处理 `schema` 不匹配、HTTP 501/502、空事件窗口。

## 13. 联调命令

SCP 仓库内已有 smoke 测试，可作为桌面端契约参考：

```bash
npm run smoke:desktop-bridge
```

该测试会：

- 通过 MCP 启动 bridge。
- 请求 `/health`、`/runs`、`/run/:runId`、`/events`、`/events/stream`。
- 验证 `bridge.json` 写入和停止后删除。
- 验证非 loopback 默认拒绝。

桌面端新实现至少要通过同等行为。

## 14. 传输契约与展示契约的边界

本文前面各节描述的是**传输/渲染载荷契约**：桌面端如何发现 bridge、如何拉取数据、如何渲染 `scp.run-view/v1`。除此之外，桌面端还涉及另一类独立的**展示行为契约**：界面有哪几种观察模式、每种模式的信息架构与降级规则、token 真实性等 UX 不变量。两者必须区分清楚，不要把展示行为约定塞回传输 schema，也不要把传输字段当成展示规范。

### 14.1 传输 / 渲染载荷契约

负责“数据怎么来、长什么样”。这一层的规范来源就是本 handoff 文档自身（§1–§13）：bridge 发现、HTTP endpoints、SSE 流、轮询降级、错误分级、TS 类型。传输层消费的视图模型由主插件定义：

- `agent-orchestration-kit/schemas/desktop-status.schema.json`
- 对应的视图模型标识 `scp.run-view/v1`（以及 `scp.event-view/v1`、`scp.token-evidence/v1`、`scp.bridge-discovery/v1`、`scp.bridge-health/v1`、`scp.bridge-events/v1` 等传输层标识）

这套视图模型由主插件 `buildRunViewModel()` 产出，是桌面端唯一可信的数据来源。它只保证字段形状和 redacted 边界，不规定桌面端如何排版、如何分模式、如何降级——后者属于 §14.2 的展示行为契约。

### 14.2 展示行为 / 模式 / UX 不变量契约

负责“界面怎么表现、有哪些模式、什么是真”。这一层的规范来源是主插件侧的 `desktop-display-contracts` 契约，不是桌面端仓库里的设计稿：

- 规范契约（normative，唯一行为准绳）：`agent-orchestration-kit/docs/desktop-display-contracts.md`，契约标识 `scp.desktop-display-contracts/v1`。
- 机器可校验镜像：`agent-orchestration-kit/schemas/desktop-display-contracts.schema.json`。
- 桌面端编译期类型镜像：`subagent-monitor-desktop/src/types/displayContracts.ts`。
- 设计来源（non-normative，仅设计理由与布局指引）：`subagent-monitor-desktop/docs/display-modes-design.md`。当设计稿与契约冲突时，以契约为准。

三种观察模式的**规范机器 ID** 为 `right-dock`（Side Monitor，右侧伴随）、`workbench`（Workbench，主工作台，默认主模式）、`wallboard`（Wallboard，大屏）。“Mode 1 / Mode 2 / Mode 3” 只是设计稿里的别名，配置、telemetry、schema、TS 类型中一律使用上述规范 ID。各模式的信息架构、共存规则、空态/失联态、reduced motion、token 真实性等 UX 不变量均以上述契约文件为准；本 handoff 文档只负责把数据送到，不重复定义展示行为。

### 14.3 wallboard v2 不得在 v1 伪造

`display-modes-design.md` 已明确 Mode 3 拆为两层：

- **v1**：基于现有 `scp.run-view/v1` 契约可落地的真实 wallboard（活跃 agent 数、session clusters、事件脉搏、保守的累积 token 计数）。
- **v2**：需要主插件在未来扩充 runtime schema 后才能做完整的 conductor / handoff 叙事，包括调度边、handoff 边、attempt/retry 计数、token throughput window、明确的 parent/child/dependency relation。

在 v2 所需字段未进入 `desktop-status.schema.json` 之前，`Conductor Sweep`、`Handoff Ribbon`、`Token River` 等只能做成视觉猜测，违背“真实性优先”原则。因此：

- v1 不得伪造 agent-to-agent handoff 边、controller-to-agent 拓扑、retry churn vs productive output 区分、原生 token 流速。
- 这些内容属于 v2，依赖主插件 schema 扩展，桌面端不要在 v1 里用合成数据假装存在。

## 15. 混合 Claude + Codex worker 可见性

本节描述当一次 run 同时包含 Claude subagent 任务和 Codex worker 任务时，桌面端如何区分与展示二者。新增的字段都是**可选**的，仅为提升 worker 维度的可见性，不改变 §1–§14 已建立的契约，也不破坏既有 `scp.run-view/v1` 消费者。

### 15.1 新增 taskView / activeTaskView 可选字段

在 `scp.run-view/v1` 的 `taskView`（`schemas/desktop-status.schema.json` 的 `#/$defs/taskView`）以及 `activeTaskView`（`#/$defs/activeTaskView`）中新增以下可选字段。它们都允许 `null`，且**允许整体缺失**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `runtime` | `"claude"` \| `"codex"` \| `null` | 该任务由哪个 agent runtime 执行。`claude` = 通过 SCP 心跳/事件驱动的 Claude subagent；`codex` = Codex worker 任务。 |
| `dispatcher` | `"scp-claude"` \| `"codex-worker"` \| `null` | 任务的派发来源。`scp-claude` = 由 SCP Node MCP runtime 派发为 Claude subagent；`codex-worker` = 作为 Codex worker 派发。 |
| `workerType` | `string` \| `null` | 解析后的 worker/agent 类型，如 `huoshan-worker`、`zhipu-worker`、`normal-worker`，或 Claude 任务角色。对 SCP 透明。 |
| `workerAlias` | `string` \| `null` | 用户侧原始别名/昵称，如 `huoshan`、`zhipu`；当用户直接写 `xxx-worker` 时可与 `workerType` 相同。对 SCP 透明。 |
| `fallbackApplied` | `boolean` \| `null` | `true` 表示 Codex worker 解析时发生了 worker fallback（如 `zhipu-worker` 缺失后使用 `normal-worker`）。它不表示 UI 展示降级。 |
| `observability` | `"live"` \| `"summary-only"` \| `null` | `live` = 有真实 live events / heartbeat 可跟踪；`summary-only` = 只能观察摘要/终态。`summary-only` 不是失败，也不能因为没有 heartbeat 就被当成 stale。 |

消费者契约：

- 这些字段全部可选，消费者**必须容忍缺失或为 `null`**。字段缺失**不代表** `runtime="claude"`，也不得据此反推；缺失只意味着未知/不适用。
- 不得因为出现这些字段而改变对 `schema`、`status`、`counts`、`health` 等既有字段的解读。
- `runtime` 与 `dispatcher` 仅描述任务执行与派发来源，不承诺任何调度拓扑、父子关系或 handoff 边（见 §14.3）。
- `activeTasks[]` 不再是 undocumented object[]；它遵循 `activeTaskView` 契约，producer 必须稳定排序，避免 snapshot 间无意义抖动。

### 15.2 Claude 任务保持完整可见

`runtime="claude"` / `dispatcher="scp-claude"` 的任务保持 SCP 原有的完整可见性：

- 完整的心跳（heartbeat）、checkpoint、phase/task 转换、`commandsRun`、`verification`、`recentEvents` 增量窗口。
- `lastUsefulEventAt` / `stalenessMs` 可正常计算，桌面端可按 §5.4、§5.5 做 live 更新。
- `observability` 应为 `live`（显式提供时）或保持缺失/`null` 但语义上仍按 live 处理。
- 这些任务的展示行为与 §1–§13 完全一致，`fallbackApplied` 应为 `false` 或 `null`。

### 15.3 Codex worker 任务可能是摘要/终态

`runtime="codex"` / `dispatcher="codex-worker"` 的任务，**除非 host 之后显式暴露 live events**，否则桌面端只能拿到摘要/终态表示：

- 可能只有 `status`、`displayStatus`、`startedAt`/`endedAt`、`durationMs`、`filesChanged`、`tokenEvidence` 等终态字段，缺少细粒度 heartbeat/event 增量。
- `recentEvents` 可能为空或只有终止事件；`lastUsefulEventAt` 可能等于 `endedAt`，`stalenessMs` 在该任务终态后不再有进展意义。
- `observability` 应为 `summary-only`（显式提供时）或保持缺失/`null` 但按 summary-only 边界对待。
- 桌面端应在 UI 上区分“live 跟踪中”与“摘要/终态”两种呈现，但**不得伪造**缺失的 live 事件或心跳（遵守 §14.3 的真实性优先原则）。这类展示降级不能写入 `fallbackApplied`；该字段只描述 worker alias fallback。
- Codex worker 任务的 live 可见性取决于 host 是否暴露事件，本契约不承诺其一定可 live 跟踪。

### 15.4 freshness / stale 语义

- 顶层 `staleThresholdMs` 是 run-view producer 给出的统一 stale 判定阈值。
- `health.staleCount` 只统计 `observability="live"` 的 active task。
- `summary-only` task 即使没有 heartbeat / lastEventAt，也不能仅凭这一点进入 stale / stalled 统计。
- `stalenessMs` 对 live task 是 freshness 信号；对 summary-only task 不代表 live 健康度。

### 15.5 `counts` 与 `sequence` 语义补充

- `counts.running`、`counts.pending` 与 `counts.partial` 必须分离；桌面端不得把进行态混入 partial。
- `recentEvents[].sequence` 是 **run-global monotonic cursor**，作用于“合并后的 run 事件流”。
- `/events?afterSequence=` 与 SSE 增量消费都基于这个 run-global cursor，不基于 task-local heartbeat 序号。

### 15.6 桌面端只读，不得派发/取消 Codex worker

- 桌面端仍是 **只读观察者**（见 §1、§7）。即使现在能区分 Codex worker 任务，桌面端**不得**派发、重试、取消或清理 Codex worker，也不得写 `.subagent-runs/` 或任何 run artifact。
- bridge 只有 `GET`，无写接口；dispatch/cancel/cleanup 一律由 Codex/SCP 总控通过 MCP 工具执行。`runtime`/`dispatcher` 等字段仅用于展示分层，不授予桌面端任何控制权。

### 15.7 关于 SCP runtime 与 Codex worker 的关系

- `dispatcher="scp-claude"` 明确表示任务由 SCP Node MCP runtime 派发为 Claude subagent。
- `dispatcher="codex-worker"` 表示任务作为 Codex worker 派发。**本契约不声称 SCP Node MCP runtime 直接 spawn Codex worker**；Codex worker 的实际启动与生命周期由 Codex 侧负责，SCP 视图模型只消费其可观测的摘要/终态结果。
- 桌面端不应假设 SCP 与 Codex worker 之间存在某种受 SCP 控制的父子进程关系或 handoff 拓扑；这类关系属于 §14.3 所述 v2 范畴，在对应 schema 字段进入 `desktop-status.schema.json` 之前不得在 v1 伪造。

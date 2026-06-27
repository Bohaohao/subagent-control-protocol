# Subagent Control Protocol

[![English](https://img.shields.io/badge/English-README-2563eb)](https://github.com/Bohaohao/subagent-control-protocol/blob/main/README.md)
[![简体中文](https://img.shields.io/badge/简体中文-README-ef4444)](https://github.com/Bohaohao/subagent-control-protocol/blob/main/README.zh-CN.md)

Subagent Control Protocol，简称 **SCP**，是一个让 Codex 作为总控来编排多种子代理的插件。

它包含两层能力：

- 一个 **MCP runtime**，负责运行 Claude Code CLI 子代理
- 一个 **orchestrator Skill**，负责教会 Codex 如何先拆 `todoList`、分析并行点、把任务路由给 Claude 或具名 Codex worker、收集结果并整合 review

它的目标很直接：**让 Codex 始终做总控，让子代理做有边界的施工，并且所有结果都结构化返回。**

## 它能做什么

SCP 支持混合调度：

- `claude` 走内置的 SCP MCP runtime
- 非 `claude` 名称，例如 `huoshan`、`zhipu`、`xxx-worker`，会被当作 Codex worker 别名
- Codex 先生成一份共享 `todoList`，再分析依赖、判断并行、派发任务、回收结果、整合 review

每个 worker 都应该返回结构化结果，至少包含：

- 状态
- 结果摘要
- 修改了哪些文件
- 跑了哪些命令
- 验证证据
- 风险
- 下一步建议
- token 使用摘要

## 为什么要用它

SCP 解决的是单纯 `claude -p` 不够用的场景：

- 你希望 Codex 真正做总控，而不是只转发一句 prompt
- 你希望多子代理并行施工时有明确的文件边界
- 你希望实现完之后强制追加 review 子代理
- 你希望拿到结构化结果，而不是一大段难整理的日志
- 你希望后续接桌面监控、事件流和 bridge

## 安装方式

### 推荐：通过 Codex 插件市场安装

先把这个仓库加到 marketplace：

```bash
codex plugin marketplace add Bohaohao/subagent-control-protocol --ref main
```

然后在 Codex 中启用插件，并重启 Codex。

安装完成后，确认：

- `subagent-control-protocol` 插件已启用
- `/mcp` 中能看到对应 runtime

### 兜底：手动安装

仅在你的 Codex 版本不支持 plugin marketplace 时使用。

1. 克隆仓库并安装依赖：

```bash
git clone https://github.com/Bohaohao/subagent-control-protocol.git
cd subagent-control-protocol
npm install
```

2. 链接命令：

```bash
npm link
```

3. 在 `~/.codex/config.toml` 中注册 MCP。

Windows：

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

macOS / Linux：

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

4. 把 orchestrator Skill 复制到 `~/.codex/skills/subagent-orchestrator/`。

## 快速使用

大多数时候，你的提示词可以非常短。

### 只派 Claude

```text
使用 Claude 子agent施工这个任务
```

### 混合 Claude + Codex worker

```text
开始做任务一、任务二，任务一让 Claude 并行去做，任务二派三个 huoshan 和三个 zhipu 并行来做
```

### 只做 review

```text
使用 Claude 子agent只读评审这个任务
```

## 总控规则

SCP 对总控的行为有明确约束：

1. 先生成 `todoList`
2. 标记依赖、写入边界和可并行点
3. 所有派发都从同一份 todoList 出发
4. 实现完成后必须追加两个只读 review 子代理：
   - 软件工程视角 review
   - 真实用户视角 review
5. 结果统一归一，最后由 Codex 整合输出

路由规则：

- `claude` 是保留关键字，只能走 SCP MCP runtime
- `huoshan` 会解析成 `huoshan-worker`
- `zhipu` 会解析成 `zhipu-worker`
- 精确的 `xxx-worker` 按原名使用
- 找不到目标 worker 时，回退到 `normal-worker`
- 如果 `normal-worker` 也不存在，这个分支直接 blocked

## 超时与恢复

SCP 里的 `timeoutMs` 是 **空闲超时**，不是绝对墙钟时长。

重要规则：

- 子代理超时后，Codex 先收集它已经产出的进度
- 然后把剩余工作整理成 continuation todo
- 再重新派发一个**新的子代理**继续做
- **不会**因为超时就默认让 Codex 亲自接管剩余工作
- 只有用户明确要求 Codex 亲自做时，Codex 才会接手

Codex worker 的限流还有额外恢复规则：

- 如果 worker 终态里明确出现 `429` / 限流信号，Codex 会发送 `继续`
- 每个 worker 最多自动续 3 次

## 桌面端集成

SCP 是**状态源**，桌面端是**只读观察者**。

也就是说：

- SCP 负责 run 状态、心跳、事件和结果
- 桌面端只负责展示
- 桌面端不能自己派发、取消或篡改 run 状态

SCP 已经提供：

- 结构化 run artifacts
- 桌面状态 view model
- 只读本地 bridge
- 供外部组件发现 bridge 的 discovery 信息

## 文档导航

详细文档在 `docs/` 下。

- [子代理协议](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/subagent-protocol.md)
- [桌面端联调 handoff](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/desktop-integration-handoff.md)
- [桌面展示契约](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/desktop-display-contracts.md)
- [插件市场发布说明](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/plugin-marketplace-release.md)
- [MCP 优化路线图](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/mcp-optimization-roadmap.md)
- [验证记录](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/verification-notes.md)

## 开发命令

安装依赖：

```bash
npm install
```

常用命令：

```bash
npm run build
npm run check
npm run build:check
npm run verify:marketplace
npm run verify:bundle
npm run smoke:mcp
```

`build` 会做三件事：

- 把 runtime 打包进 `dist/`
- 生成更新清单
- 同步可发布插件目录 `plugins/subagent-control-protocol/`

## 仓库结构

```text
.
├─ src/                                      runtime 源码
├─ skills/subagent-orchestrator/             总控工作流 skill
├─ docs/                                     详细协议与联调文档
├─ dist/                                     打包后的 runtime 与更新清单
├─ plugins/subagent-control-protocol/        可发布插件目录
├─ schemas/                                  公共 JSON schema
└─ scripts/                                  校验与 smoke 脚本
```

## License

MIT

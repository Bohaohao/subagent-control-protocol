# Subagent Control Protocol

[![English](https://img.shields.io/badge/English-README-2563eb)](https://github.com/Bohaohao/subagent-control-protocol/blob/main/README.md)
[![简体中文](https://img.shields.io/badge/简体中文-README-ef4444)](https://github.com/Bohaohao/subagent-control-protocol/blob/main/README.zh-CN.md)

Subagent Control Protocol, or **SCP**, is a Codex plugin for controller-led multi-agent work.

It gives Codex two coordinated layers:

- an **MCP runtime** for running Claude Code CLI subagents
- an **orchestrator Skill** that teaches Codex how to split work into a todo list, decide what can run in parallel, route work to Claude or named Codex workers, collect results, and integrate review feedback

The goal is simple: let Codex stay the controller, while subagents do bounded work with structured results.

## What It Does

SCP supports a mixed orchestration model:

- `claude` is routed through the bundled SCP MCP runtime
- non-`claude` names such as `huoshan`, `zhipu`, or `xxx-worker` are treated as Codex worker aliases
- Codex creates one shared `todoList`, analyzes dependencies and parallelism, dispatches work, and merges the results

Every worker is expected to return a structured result that includes:

- status
- summary
- files changed
- commands run
- verification evidence
- risks
- next steps
- token usage summary

## Why Use It

SCP is for the cases where `claude -p` alone is not enough:

- you want Codex to act as a real controller instead of a thin relay
- you want safe parallel work with explicit file ownership
- you want mandatory review agents after implementation
- you want structured outputs instead of long free-form logs
- you want desktop monitoring, event streams, and bridge-based status integration

## Installation

### Recommended: Codex Plugin Marketplace

Add this repository as a marketplace source:

```bash
codex plugin marketplace add Bohaohao/subagent-control-protocol --ref main
```

Then enable the plugin in Codex and restart Codex.

After installation, confirm that:

- the `subagent-control-protocol` plugin is enabled
- the MCP runtime is available in `/mcp`

### Fallback: Manual Install

Use this only if your Codex build does not support plugin marketplaces.

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/Bohaohao/subagent-control-protocol.git
cd subagent-control-protocol
npm install
```

2. Link the command:

```bash
npm link
```

3. Register the MCP server in `~/.codex/config.toml`.

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

4. Copy the orchestrator Skill into `~/.codex/skills/subagent-orchestrator/`.

## Quick Usage

Most of the time, the prompt can stay short.

### Claude-only

```text
Use Claude subagents to work on this task.
```

### Mixed Claude + Codex workers

```text
Task one should be handled by Claude in parallel.
Task two should be handled by three huoshan workers and three zhipu workers in parallel.
```

### Review-only

```text
Use Claude subagents to review this task in read-only mode.
```

## Controller Rules

SCP is opinionated. The controller is expected to behave like this:

1. Build a `todoList` first.
2. Mark dependencies, write boundaries, and parallel-safe slices.
3. Dispatch from that shared todo list.
4. Add two read-only review agents after implementation:
   - software-engineering review
   - real-user review
5. Normalize results and integrate them in Codex.

Routing rules:

- `claude` is reserved and always goes through the SCP MCP runtime
- `huoshan` resolves to `huoshan-worker`
- `zhipu` resolves to `zhipu-worker`
- exact `xxx-worker` names are used as-is
- missing worker aliases fall back to `normal-worker`
- if `normal-worker` is also missing, that branch is blocked

## Timeout and Recovery Behavior

SCP treats `timeoutMs` as an **idle timeout**, not a wall-clock deadline.

Important controller rule:

- when a subagent times out, Codex should first collect whatever progress already exists
- then Codex should create a continuation todo and dispatch a **fresh subagent**
- Codex should **not** silently take over the unfinished work by default
- Codex should only take over personally when the user explicitly asks it to do so

Codex worker rate limits also have a recovery rule:

- if a Codex worker ends with a clear `429` / rate-limit signal, Codex sends `继续`
- recovery is attempted up to 3 times per worker

## Desktop Integration

SCP is the **status source**. A desktop app is a **read-only observer**.

That means:

- SCP owns run state, heartbeats, events, and task results
- the desktop app renders them
- the desktop app must not dispatch, cancel, or mutate run state on its own

SCP includes:

- structured run artifacts
- desktop status view models
- a read-only local bridge
- bridge discovery metadata for external widgets

## Docs

Detailed documents live under `docs/`.

- [Subagent protocol](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/subagent-protocol.md)
- [Desktop integration handoff](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/desktop-integration-handoff.md)
- [Desktop display contracts](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/desktop-display-contracts.md)
- [Plugin marketplace release notes](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/plugin-marketplace-release.md)
- [MCP optimization roadmap](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/mcp-optimization-roadmap.md)
- [Verification notes](https://github.com/Bohaohao/subagent-control-protocol/blob/main/docs/verification-notes.md)

## Development

Install dependencies:

```bash
npm install
```

Common commands:

```bash
npm run build
npm run check
npm run build:check
npm run verify:marketplace
npm run verify:bundle
npm run smoke:mcp
```

The build does three things:

- bundles the runtime into `dist/`
- writes the update manifest
- syncs the publishable plugin bundle under `plugins/subagent-control-protocol/`

## Repository Layout

```text
.
├─ src/                                      runtime source
├─ skills/subagent-orchestrator/             controller workflow skill
├─ docs/                                     detailed protocol and integration docs
├─ dist/                                     bundled runtime and update manifest
├─ plugins/subagent-control-protocol/        publishable plugin bundle
├─ schemas/                                  shared JSON schemas
└─ scripts/                                  verification and smoke-test scripts
```

## License

MIT

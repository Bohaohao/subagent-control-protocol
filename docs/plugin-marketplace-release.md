# Plugin Marketplace Release & Runtime Updates

This document covers the final install/update architecture for the Subagent
Control Protocol (SCP) plugin:

- **Install** via a Codex plugin marketplace when supported, with manual
  MCP + Skill install as a fallback.
- **Runtime self-update** applied on Codex restart by the bundled
  `dist/bootstrap.mjs` launcher.
- **Skill / plugin metadata updates**, which follow the marketplace
  refresh/upgrade cycle.

For the user-facing install steps, see the [Installation](../README.md#installation)
and [Update model](../README.md#update-model) sections of the README. This doc
records the precise behavior and release notes for contributors.

## Install paths

### Recommended: Codex plugin marketplace

The repo is a Codex plugin bundle (`.codex-plugin/plugin.json` + `.mcp.json` +
`skills/`). Add it as a marketplace source and install/enable the plugin:

```bash
# Add this repo as a marketplace source (owner/repo)
codex plugin marketplace add Bohaohao/subagent-control-protocol
# optionally pin to a branch/tag:
codex plugin marketplace add Bohaohao/subagent-control-protocol --ref main
```

Then install/enable the plugin — either via the `/plugins` view inside a Codex
session, or by placing it in your Codex app plugin directory and enabling it
there. Restart Codex (or start a new thread) once enabled, and confirm with
`/mcp`.

> Codex marketplace commands evolve between releases. The forms above match the
> documented marketplace behavior. If your CLI differs (different subcommand
> names or flags), use the manual fallback below rather than assuming an
> unsupported command works.

Marketplace install activates the plugin MCP runtime and the orchestrator Skill as one
unit — no manual Skill copy is needed.

### Fallback: manual MCP + Skill install

For environments without plugin marketplace support:

1. Clone the repo, `npm install`, `npm link` so `subagent-control-protocol` is
   on `PATH`.
2. Register the plugin MCP command in `~/.codex/config.toml` (see
   [README](../README.md#manual-installation-fallback)).
3. Copy `skills/subagent-orchestrator/` into `~/.codex/skills/`.
4. Restart Codex and run `/mcp`.

## Prerequisites

- **Node.js 20+**.
- **Claude Code CLI** installed and authenticated (`claude` runs in a terminal).
- **A MCP-capable Codex client.**
- **Network access** for marketplace/bootstrap runtime self-update, unless disabled
  (`SCP_DISABLE_AUTO_UPDATE=1`).

## Update model

Two independent channels — do not conflate them.

### 1. Runtime self-update (plugin MCP runtime)

For marketplace installs, the bundled `dist/bootstrap.mjs` launcher runs before
the execution runtime starts. It fetches an update manifest, compares it to the locally
cached runtime build, and applies a newer build into the cache if one is
available. The plugin runtime then starts from the cached build. Manual installs
that launch the package bin update with `git pull` and `npm link` instead.

Scope:

- Updates the MCP **process/tool layer** (`src/`, the four tools, scheduler,
  claude-runner, result normalizer).
- Does **not** update Skill or plugin metadata — those live in the marketplace
  bundle.
- Requires network access to reach the manifest/build URLs. Disable for
  air-gapped or pinned setups with `SCP_DISABLE_AUTO_UPDATE=1`.

Because marketplace/bootstrap self-update applies at restart, a single Codex
restart is enough to pull the latest plugin MCP runtime; you do not need to
re-run the marketplace install just to refresh the runtime code.

### 2. Skill / plugin metadata updates

The orchestrator Skill (`skills/subagent-orchestrator/SKILL.md`) and the plugin
manifest (`.codex-plugin/plugin.json`) ship inside the marketplace bundle. They
are refreshed only when the marketplace is refreshed or the plugin is upgraded —
either:

- manually, by re-running the marketplace add/upgrade flow, or
- automatically, if your Codex build auto-refreshes marketplaces.

The runtime self-update does **not** touch these files. If a release changes
delegation workflow rules (the Skill) or plugin capabilities/defaults (the
manifest), users must upgrade through the marketplace to pick them up.

### Summary

| What | Channel | When it applies |
| --- | --- | --- |
| Plugin MCP runtime (`src/`) | Runtime self-update via `dist/bootstrap.mjs` | On Codex restart (network permitting) |
| Orchestrator Skill | Marketplace refresh/upgrade | When the marketplace is refreshed or the plugin is upgraded |
| Plugin manifest / capabilities | Marketplace refresh/upgrade | When the marketplace is refreshed or the plugin is upgraded |

## Environment controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCP_DISABLE_AUTO_UPDATE` | unset (self-update enabled) | Set to `1`/truthy to disable runtime self-update at startup for marketplace/bootstrap installs. For air-gapped or pinned environments. |
| `SCP_UPDATE_MANIFEST_URL` | manifest published with the release | Override the manifest URL the bootstrap launcher fetches. Point at a mirror or a pinned manifest for reproducible installs. |
| `SCP_UPDATE_CACHE_DIR` | platform default cache location | Directory for downloaded runtime builds. Override to relocate onto writable or persistent storage. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI executable used to spawn subagents. Set in the plugin MCP env block when `claude` is not on `PATH`. |

## Release checklist

1. Bump `version` in `package.json` and `.codex-plugin/plugin.json` together.
2. Publish the runtime update manifest + build at `SCP_UPDATE_MANIFEST_URL` (or
   the default manifest location) so `dist/bootstrap.mjs` can pick it up.
3. Tag the release and push so the marketplace source (`--ref`) can resolve it.
4. Confirm the plugin bundle (`.agents/plugins/marketplace.json`,
   `.codex-plugin/plugin.json`, `.mcp.json`, `dist/`, `skills/`) is intact — this is what the marketplace installs.
5. Note in the release notes whether the release includes Skill/manifest changes
   (marketplace upgrade required) or runtime-only changes (self-update on
   restart suffices).

## Notes

- The repo root is both the repo marketplace root and the plugin bundle.
  `.agents/plugins/marketplace.json` exposes `source.path: "./"`, which points
  back at this bundle.
- Never disable self-update expecting Skill updates to flow through the runtime
  channel — they do not. Skill/metadata changes always require a marketplace
  upgrade.
- Marketplace command surface is Codex-controlled and may change between Codex
  releases; treat the `codex plugin marketplace add ...` forms as the documented
  behavior and fall back to manual install when in doubt.

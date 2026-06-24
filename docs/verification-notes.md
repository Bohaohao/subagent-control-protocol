# Verification Scripts

Two standalone scripts validate the final architecture (bundled MCP runtime +
repo-marketplace plugin packaging) without depending on `package.json` scripts.
The controller may wire them into npm scripts later; running them directly also
works.

## `scripts/verify-bundle-runtime.mjs`

Verifies the bundled MCP runtime `dist/server.mjs`:

1. Confirms `dist/server.mjs` exists.
2. Static-checks that the bundle has **no bare imports** of
   `@modelcontextprotocol/sdk` or `zod` — esbuild should have inlined these, and
   a leftover bare import would break the dependency-free bundle at runtime.
3. Launches `node dist/server.mjs` and runs a basic MCP stdio smoke test over
   JSON-RPC: `initialize` → `notifications/initialized` → `tools/list`, and
   asserts the tool list includes the core subagent tools
   (`subagent_run_task`, `subagent_run_many`, `subagent_status`).

The script uses only Node built-ins (no `@modelcontextprotocol/sdk` client) so
it can run against a checkout where `node_modules` is absent. It is hard
time-bounded: each RPC has a 15 s timeout and an overall 45 s watchdog, so a
hung server cannot stall CI.

Run directly:

```bash
node scripts/verify-bundle-runtime.mjs
```

Exits non-zero with a list of failures on any error; prints `OK` on success.

## `scripts/verify-marketplace-plugin.mjs`

Verifies the installable plugin / repo-marketplace packaging is present and
internally consistent. Confirms all bundle parts exist:

- `.agents/plugins/marketplace.json`
- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/` (must be non-empty)
- `dist/bootstrap.mjs`
- `dist/server.mjs`
- `dist/latest.json`

Then parses the JSON and cross-checks consistency:

- `marketplace.json` has top-level `name`, `interface`, and a non-empty
  `plugins` array containing an entry named `subagent-control-protocol`.
- The plugin entry's `source.path` (resolved relative to the repo root, i.e.
  the marketplace root) points to a directory that contains
  `.codex-plugin/plugin.json`. For the repo-as-plugin-bundle architecture this
  is typically `./`.
- `plugin.json` name matches the marketplace plugin entry name; its `skills`
  and `mcpServers` pointers resolve to existing paths.
- `.mcp.json` registers a `node` server named
  `subagent-control-protocol` whose args reference `./dist/bootstrap.mjs`
  (which must exist) and whose env preserves `CLAUDE_BIN=claude`.
- `dist/latest.json` has `name`/`version` and references a server file that
  exists in `dist/`.

Run directly:

```bash
node scripts/verify-marketplace-plugin.mjs
```

Exits non-zero with a list of failures on any error; prints `OK` on success.

## Notes

- Both scripts are read-only and never modify files.
- Neither script edits or depends on `package.json`.
- They only validate bundle and marketplace packaging behavior.

#!/usr/bin/env node
// Standalone verification of the repo marketplace packaging.
//
// The repository root is the marketplace root. The installable Codex plugin
// bundle lives under plugins/subagent-control-protocol, matching Codex's
// repo/team marketplace path convention.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const PLUGIN_NAME = 'subagent-control-protocol'
const EXPECTED_PLUGIN_PATH = `./plugins/${PLUGIN_NAME}`

const errors = []

function ok(message) {
  console.log(`  OK ${message}`)
}

function fail(message) {
  errors.push(message)
  console.error(`  FAIL ${message}`)
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readJson(baseDir, rel, label) {
  const abs = path.join(baseDir, rel)
  if (!(await exists(abs))) {
    fail(`${label} not found: ${path.relative(root, abs)}`)
    return null
  }
  try {
    return JSON.parse(await fs.readFile(abs, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON (${path.relative(root, abs)}): ${error.message}`)
    return null
  }
}

async function requirePath(baseDir, rel) {
  const abs = path.join(baseDir, rel)
  if (await exists(abs)) {
    ok(`${path.relative(root, abs)} exists`)
  } else {
    fail(`missing required path: ${path.relative(root, abs)}`)
  }
}

async function loadMarketplace() {
  const marketplace = await readJson(root, '.agents/plugins/marketplace.json', 'marketplace.json')
  if (!marketplace) return null

  if (typeof marketplace.name === 'string' && marketplace.name) {
    ok(`marketplace.name = ${marketplace.name}`)
  } else {
    fail('marketplace.json missing top-level "name"')
  }
  if (!marketplace.interface || typeof marketplace.interface !== 'object') {
    fail('marketplace.json missing top-level "interface"')
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    fail('marketplace.json "plugins" must be a non-empty array')
    return null
  }

  const entry = marketplace.plugins.find((p) => p && p.name === PLUGIN_NAME)
  if (!entry) {
    fail(`marketplace.json has no plugin entry named "${PLUGIN_NAME}"`)
    return null
  }
  if (!entry.source || entry.source.source !== 'local') {
    fail(`marketplace plugin "${PLUGIN_NAME}" source.source must be "local"`)
  }
  if (!entry.source || entry.source.path !== EXPECTED_PLUGIN_PATH) {
    fail(
      `marketplace plugin "${PLUGIN_NAME}" source.path must be "${EXPECTED_PLUGIN_PATH}"`,
    )
  } else {
    ok(`marketplace source.path = ${entry.source.path}`)
  }
  if (!entry.policy || entry.policy.installation !== 'AVAILABLE') {
    fail('marketplace plugin policy.installation must be AVAILABLE')
  }
  if (!entry.policy || entry.policy.authentication !== 'ON_INSTALL') {
    fail('marketplace plugin policy.authentication must be ON_INSTALL')
  }
  if (typeof entry.category !== 'string' || !entry.category) {
    fail('marketplace plugin entry missing category')
  }

  const pluginRoot = path.resolve(root, entry.source && entry.source.path ? entry.source.path : '')
  const stat = await fs.stat(pluginRoot).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    fail(`marketplace source.path does not resolve to a directory: ${pluginRoot}`)
    return null
  }
  return { entry, pluginRoot }
}

async function checkPluginBundle(pluginRoot) {
  await requirePath(root, '.agents/plugins/marketplace.json')
  await requirePath(pluginRoot, '.codex-plugin/plugin.json')
  await requirePath(pluginRoot, '.mcp.json')
  await requirePath(pluginRoot, 'skills')
  await requirePath(pluginRoot, 'dist/bootstrap.mjs')
  await requirePath(pluginRoot, 'dist/server.mjs')
  await requirePath(pluginRoot, 'dist/latest.json')

  const skillEntries = await fs.readdir(path.join(pluginRoot, 'skills')).catch(() => [])
  if (skillEntries.length === 0) fail('plugin skills directory is empty')
}

async function checkPluginManifest(pluginRoot, marketplaceEntry) {
  const plugin = await readJson(pluginRoot, '.codex-plugin/plugin.json', 'plugin.json')
  if (!plugin) return null

  if (plugin.name !== PLUGIN_NAME) {
    fail(`plugin.json name "${plugin.name}" != expected "${PLUGIN_NAME}"`)
  } else {
    ok(`plugin.json name = ${plugin.name}`)
  }
  if (marketplaceEntry.name !== plugin.name) {
    fail(`name mismatch: marketplace "${marketplaceEntry.name}" vs plugin.json "${plugin.name}"`)
  }
  if (typeof plugin.version !== 'string' || !plugin.version) {
    fail('plugin.json missing "version"')
  }
  if (typeof plugin.skills !== 'string') {
    fail('plugin.json missing "skills" pointer')
  } else if (!(await exists(path.join(pluginRoot, plugin.skills.replace(/^\.\//, ''))))) {
    fail(`plugin.json "skills" points at missing path: ${plugin.skills}`)
  }
  if (typeof plugin.mcpServers !== 'string') {
    fail('plugin.json missing "mcpServers" pointer')
  } else if (!(await exists(path.join(pluginRoot, plugin.mcpServers.replace(/^\.\//, ''))))) {
    fail(`plugin.json "mcpServers" points at missing path: ${plugin.mcpServers}`)
  }
  return plugin
}

async function checkMcpRegistration(pluginRoot) {
  const mcp = await readJson(pluginRoot, '.mcp.json', '.mcp.json')
  if (!mcp) return

  const entry = mcp.mcpServers && mcp.mcpServers[PLUGIN_NAME]
  if (!entry) {
    fail(`.mcp.json has no server named "${PLUGIN_NAME}"`)
    return
  }
  if (entry.command !== 'node') {
    fail(`.mcp.json "${PLUGIN_NAME}".command should be "node"`)
  }
  const args = Array.isArray(entry.args) ? entry.args : []
  const bootstrapArg = args.find((a) => typeof a === 'string' && a.includes('bootstrap.mjs'))
  if (!bootstrapArg) {
    fail(`.mcp.json "${PLUGIN_NAME}".args does not reference ./dist/bootstrap.mjs`)
  } else if (!(await exists(path.join(pluginRoot, bootstrapArg.replace(/^\.\//, ''))))) {
    fail(`.mcp.json references missing bootstrap file: ${bootstrapArg}`)
  } else {
    ok(`.mcp.json launches node ${bootstrapArg}`)
  }
  if (!entry.env || entry.env.CLAUDE_BIN !== 'claude') {
    fail('.mcp.json server env should preserve CLAUDE_BIN=claude')
  }
}

async function checkLatestManifest(pluginRoot, plugin) {
  const latest = await readJson(pluginRoot, 'dist/latest.json', 'dist/latest.json')
  const pkg = await readJson(root, 'package.json', 'package.json')
  if (!latest || !pkg || !plugin) return

  if (latest.name !== PLUGIN_NAME) fail(`dist/latest.json name "${latest.name}" != ${PLUGIN_NAME}`)
  if (pkg.version !== plugin.version || pkg.version !== latest.version) {
    fail(
      `version mismatch: package.json=${pkg.version}, plugin.json=${plugin.version}, latest.json=${latest.version}`,
    )
  } else {
    ok(`version = ${latest.version}`)
  }

  const serverFilename = latest.server && latest.server.filename
  if (!serverFilename) {
    fail('dist/latest.json missing server.filename')
  } else if (!(await exists(path.join(pluginRoot, 'dist', path.basename(serverFilename))))) {
    fail(`dist/latest.json references missing server file: ${serverFilename}`)
  }
  const serverUrl = latest.server && latest.server.url
  if (
    typeof serverUrl !== 'string' ||
    !serverUrl.includes(`/plugins/${PLUGIN_NAME}/dist/server.mjs`)
  ) {
    fail('dist/latest.json server.url must point at the published plugin dist path')
  }
}

async function main() {
  console.log('verify-marketplace-plugin: checking repo marketplace packaging')

  const marketplaceInfo = await loadMarketplace()
  if (marketplaceInfo) {
    await checkPluginBundle(marketplaceInfo.pluginRoot)
    const plugin = await checkPluginManifest(marketplaceInfo.pluginRoot, marketplaceInfo.entry)
    await checkMcpRegistration(marketplaceInfo.pluginRoot)
    await checkLatestManifest(marketplaceInfo.pluginRoot, plugin)
  }

  if (errors.length > 0) {
    console.error(`\nverify-marketplace-plugin: FAILED (${errors.length} error(s))`)
    process.exit(1)
  }
  console.log('\nverify-marketplace-plugin: OK')
}

main().catch((error) => {
  console.error(`\nverify-marketplace-plugin: FAILED (uncaught ${error.stack || error.message})`)
  process.exit(1)
})

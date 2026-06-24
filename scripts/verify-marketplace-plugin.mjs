#!/usr/bin/env node
// Standalone verification of the Codex plugin / repo-marketplace packaging.
//
// Confirms the files that make up the installable bundle all exist and are
// internally consistent:
//   - .agents/plugins/marketplace.json  (repo marketplace index)
//   - .codex-plugin/plugin.json         (plugin manifest)
//   - .mcp.json                         (plugin MCP runtime registration)
//   - skills/                           (workflow Skills directory)
//   - dist/bootstrap.mjs                (startup self-update bootstrap)
//   - dist/server.mjs                   (bundled MCP runtime)
//   - dist/latest.json                  (update manifest metadata)
//
// Parses the JSON files and validates that the marketplace plugin entry's
// source.path resolves to a directory containing .codex-plugin/plugin.json,
// and that manifest/marketplace/.mcp.json cross-references line up.
//
// Does not modify any files and does not touch package.json.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const errors = []
function fail(message) {
  errors.push(message)
  console.error(`  ✗ ${message}`)
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readJson(rel, label) {
  const abs = path.join(root, rel)
  if (!(await exists(abs))) {
    fail(`${label} not found: ${rel}`)
    return null
  }
  try {
    const text = await fs.readFile(abs, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    fail(`${label} is not valid JSON (${rel}): ${error.message}`)
    return null
  }
}

async function checkRequiredFiles() {
  const required = [
    '.agents/plugins/marketplace.json',
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'skills',
    'dist/bootstrap.mjs',
    'dist/server.mjs',
    'dist/latest.json',
  ]
  for (const rel of required) {
    const isDir = rel === 'skills'
    if (await exists(path.join(root, rel))) {
      console.log(`  ✓ ${rel} exists`)
    } else {
      fail(`missing required ${isDir ? 'directory' : 'file'}: ${rel}`)
    }
  }
  // skills/ should contain at least one Skill.
  if (await exists(path.join(root, 'skills'))) {
    let entries = []
    try {
      entries = await fs.readdir(path.join(root, 'skills'))
    } catch (error) {
      fail(`cannot read skills/ directory: ${error.message}`)
    }
    if (entries.length === 0) fail('skills/ directory is empty')
  }
}

async function checkMarketplace() {
  const marketplace = await readJson('.agents/plugins/marketplace.json', 'marketplace.json')
  if (!marketplace) return null

  if (typeof marketplace.name !== 'string' || !marketplace.name) {
    fail('marketplace.json missing top-level "name"')
  } else {
    console.log(`  ✓ marketplace.name = ${marketplace.name}`)
  }
  if (!marketplace.interface || typeof marketplace.interface !== 'object') {
    fail('marketplace.json missing top-level "interface"')
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    fail('marketplace.json "plugins" must be a non-empty array')
    return null
  }

  const PLUGIN_NAME = 'subagent-control-protocol'
  const entry = marketplace.plugins.find((p) => p && p.name === PLUGIN_NAME)
  if (!entry) {
    fail(`marketplace.json has no plugin entry named "${PLUGIN_NAME}"`)
    return null
  }

  // Resolve the plugin's source.path relative to the repo (marketplace) root.
  const sourcePath =
    typeof entry.source === 'string'
      ? entry.source
      : entry.source && typeof entry.source.path === 'string'
        ? entry.source.path
        : null
  if (!sourcePath) {
    fail(`marketplace plugin "${PLUGIN_NAME}" has no source.path`)
    return null
  }
  if (typeof entry.source === 'object' && entry.source.source !== 'local') {
    fail(`marketplace plugin "${PLUGIN_NAME}" source.source must be "local"`)
  }

  const resolvedDir = path.resolve(root, sourcePath)
  const stat = await fs.stat(resolvedDir).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    fail(`marketplace source.path "${sourcePath}" does not resolve to a directory (${resolvedDir})`)
    return null
  }

  const pluginManifestInDir = path.join(resolvedDir, '.codex-plugin', 'plugin.json')
  if (!(await exists(pluginManifestInDir))) {
    fail(
      `marketplace source.path "${sourcePath}" resolves to ${resolvedDir} but it does not contain .codex-plugin/plugin.json`,
    )
  } else {
    console.log(`  ✓ marketplace source.path "${sourcePath}" -> .codex-plugin/plugin.json present`)
  }

  return { entry, resolvedDir }
}

async function checkPluginManifest(marketplaceInfo) {
  const plugin = await readJson('.codex-plugin/plugin.json', 'plugin.json')
  if (!plugin) return

  const PLUGIN_NAME = 'subagent-control-protocol'
  if (plugin.name !== PLUGIN_NAME) {
    fail(`plugin.json name "${plugin.name}" != expected "${PLUGIN_NAME}"`)
  } else {
    console.log(`  ✓ plugin.json name = ${plugin.name}`)
  }

  // Cross-check: marketplace plugin entry name matches manifest name.
  if (marketplaceInfo && marketplaceInfo.entry.name !== plugin.name) {
    fail(
      `name mismatch: marketplace plugin "${marketplaceInfo.entry.name}" vs plugin.json "${plugin.name}"`,
    )
  }

  // skills pointer should reference ./skills/ which must exist.
  if (typeof plugin.skills === 'string') {
    const skillsRel = plugin.skills.replace(/^\.\//, '')
    if (!(await exists(path.join(root, skillsRel)))) {
      fail(`plugin.json "skills" points at missing path: ${plugin.skills}`)
    }
  } else {
    fail('plugin.json missing "skills" pointer')
  }

  // mcpServers pointer should reference ./.mcp.json which must exist.
  if (typeof plugin.mcpServers === 'string') {
    const mcpRel = plugin.mcpServers.replace(/^\.\//, '')
    if (!(await exists(path.join(root, mcpRel)))) {
      fail(`plugin.json "mcpServers" points at missing path: ${plugin.mcpServers}`)
    }
  } else {
    fail('plugin.json missing "mcpServers" pointer')
  }

  // Version should be a non-empty string.
  if (typeof plugin.version !== 'string' || !plugin.version) {
    fail('plugin.json missing "version"')
  }
}

async function checkMcpRegistration(marketplaceInfo) {
  const mcp = await readJson('.mcp.json', '.mcp.json')
  if (!mcp) return

  const servers = mcp.mcpServers
  if (!servers || typeof servers !== 'object') {
    fail('.mcp.json missing "mcpServers" object')
    return
  }
  const PLUGIN_NAME = 'subagent-control-protocol'
  const entry = servers[PLUGIN_NAME]
  if (!entry) {
    fail(`.mcp.json has no server named "${PLUGIN_NAME}"`)
    return
  }

  if (entry.command !== 'node') {
    fail(`.mcp.json "${PLUGIN_NAME}".command should be "node" (got ${String(entry.command)})`)
  }

  const args = Array.isArray(entry.args) ? entry.args : []
  const bootstrapArg = args.find((a) => typeof a === 'string' && a.includes('bootstrap.mjs'))
  if (!bootstrapArg) {
    fail(`.mcp.json "${PLUGIN_NAME}".args does not reference the bootstrap (./dist/bootstrap.mjs)`)
  } else {
    // The referenced bootstrap file must actually exist.
    const rel = bootstrapArg.replace(/^\.\//, '')
    if (!(await exists(path.join(root, rel)))) {
      fail(`.mcp.json references missing bootstrap file: ${bootstrapArg}`)
    } else {
      console.log(`  ✓ .mcp.json launches node ${bootstrapArg}`)
    }
  }

  // CLAUDE_BIN env should be preserved.
  if (!entry.env || entry.env.CLAUDE_BIN !== 'claude') {
    fail('.mcp.json server env should preserve CLAUDE_BIN=claude')
  }

  // Name consistency with marketplace/plugin manifest.
  if (marketplaceInfo && marketplaceInfo.entry.name !== PLUGIN_NAME) {
    fail(`.mcp.json server name "${PLUGIN_NAME}" does not match marketplace plugin entry`)
  }
}

async function checkLatestManifest() {
  const latest = await readJson('dist/latest.json', 'dist/latest.json')
  if (!latest) return
  const pkg = await readJson('package.json', 'package.json')
  const plugin = await readJson('.codex-plugin/plugin.json', 'plugin.json')

  if (typeof latest.name !== 'string' || !latest.name) {
    fail('dist/latest.json missing "name"')
  } else {
    console.log(`  ✓ latest.json name = ${latest.name}`)
  }
  if (typeof latest.version !== 'string' || !latest.version) {
    fail('dist/latest.json missing "version"')
  }
  if (pkg && plugin && latest.version) {
    if (pkg.version !== plugin.version || pkg.version !== latest.version) {
      fail(
        `version mismatch: package.json=${pkg.version}, plugin.json=${plugin.version}, latest.json=${latest.version}`,
      )
    }
  }

  // latest.json should reference the bundled server file that exists.
  const serverRef =
    typeof latest.server === 'string'
      ? latest.server
      : latest.server && typeof latest.server.filename === 'string'
        ? latest.server.filename
        : latest.serverFilename
  if (serverRef) {
    const base = path.basename(serverRef)
    if (!(await exists(path.join(root, 'dist', base)))) {
      fail(`dist/latest.json references server file not present in dist/: ${serverRef}`)
    }
  } else {
    // Fall back to a conventional filename and warn only if also missing.
    if (!(await exists(path.join(root, 'dist', 'server.mjs')))) {
      fail('dist/latest.json has no server file reference and dist/server.mjs is missing')
    }
  }
}

async function main() {
  console.log('verify-marketplace-plugin: checking bundle + marketplace packaging')

  await checkRequiredFiles()
  const marketplaceInfo = await checkMarketplace()
  await checkPluginManifest(marketplaceInfo)
  await checkMcpRegistration(marketplaceInfo)
  await checkLatestManifest()

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

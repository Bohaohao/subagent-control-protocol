// Build script for the Subagent Control Protocol MCP runtime.
//
// Produces a self-contained dist/:
//   - dist/server.mjs    esbuild-bundled single-file ESM MCP server (node20)
//   - dist/bootstrap.mjs dependency-free startup self-update bootstrap
//   - dist/latest.json   remote update manifest (name/version/sha256/urls)
//
// The server bundle is made self-contained by inlining the agent-result JSON
// schema at build time, so the cached remote bundle can run from any directory
// without shipping schemas/ alongside it.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const distDir = path.join(rootDir, 'dist')
const schemaPath = path.join(rootDir, 'schemas', 'agent-result.schema.json')

const pkg = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'))
const schemaText = await fs.readFile(schemaPath, 'utf8')

const RAW_BASE =
  'https://raw.githubusercontent.com/Bohaohao/subagent-control-protocol/main/dist'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// Inline schemas/agent-result.schema.json into the bundle so the runtime no
// longer reads it from disk relative to import.meta.url (which would break for
// a dist/ bundle and for a remotely cached copy). The identifier substituted in
// is defined to the raw JSON, which is a valid JS object-literal expression.
const schemaInlinePlugin = {
  name: 'scp-inline-result-schema',
  setup(build) {
    build.onLoad({ filter: /[\\/]core[\\/]scheduler\.mjs$/ }, async (args) => {
      let source = await fs.readFile(args.path, 'utf8')
      const target = 'await readJson(resultSchemaPath)'
      if (!source.includes(target)) {
        throw new Error(
          `schema-inline: expected "${target}" in ${args.path}; scheduler.mjs may have changed.`,
        )
      }
      source = source.replace(target, '__SCP_RESULT_SCHEMA_INLINE__')
      return { contents: source, loader: 'js' }
    })
  },
}

async function buildServer() {
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'server.mjs')],
    outfile: path.join(distDir, 'server.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'info',
    plugins: [schemaInlinePlugin],
    define: {
      __SCP_RESULT_SCHEMA_INLINE__: schemaText,
    },
  })
}

async function copyBootstrap() {
  const source = await fs.readFile(path.join(rootDir, 'src', 'bootstrap.mjs'), 'utf8')
  if (!source.includes('__SCP_BUNDLED_VERSION__')) {
    throw new Error('bootstrap build expected __SCP_BUNDLED_VERSION__ placeholder')
  }
  await fs.writeFile(
    path.join(distDir, 'bootstrap.mjs'),
    source.replace('__SCP_BUNDLED_VERSION__', pkg.version),
    'utf8',
  )
}

async function writeManifest(serverSha) {
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    generatedAt: new Date().toISOString(),
    server: {
      filename: 'server.mjs',
      url: `${RAW_BASE}/server.mjs`,
      sha256: serverSha,
    },
  }
  await fs.writeFile(
    path.join(distDir, 'latest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )
  return manifest
}

await fs.mkdir(distDir, { recursive: true })
await buildServer()
await copyBootstrap()

const serverHash = sha256(await fs.readFile(path.join(distDir, 'server.mjs')))
const bootstrapHash = sha256(await fs.readFile(path.join(distDir, 'bootstrap.mjs')))
const manifest = await writeManifest(serverHash)

console.log(`[build] wrote dist/server.mjs (sha256 ${serverHash})`)
console.log(`[build] wrote dist/bootstrap.mjs (sha256 ${bootstrapHash})`)
console.log(`[build] wrote dist/latest.json for ${manifest.name}@${manifest.version}`)

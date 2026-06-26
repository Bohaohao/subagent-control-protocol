#!/usr/bin/env node
// Standalone verification of the bundled MCP runtime (dist/server.mjs).

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const serverPath = path.join(root, 'dist', 'server.mjs')
const bootstrapPath = path.join(root, 'dist', 'bootstrap.mjs')

const RPC_TIMEOUT_MS = 15_000
const WATCHDOG_MS = 45_000

const errors = []
function fail(message) {
  errors.push(message)
  console.error(`  [fail] ${message}`)
}

function ok(message) {
  console.log(`  [ok] ${message}`)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function extractSpecifiers(source) {
  const code = stripComments(source)
  const specs = new Set()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) {
    for (const match of code.matchAll(re)) specs.add(match[1])
  }
  return specs
}

function isBare(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:')
  )
}

function isForbidden(specifier) {
  return (
    specifier === '@modelcontextprotocol/sdk' ||
    specifier.startsWith('@modelcontextprotocol/sdk/') ||
    specifier === 'zod' ||
    specifier.startsWith('zod/')
  )
}

function createRpc(child, timeoutMs) {
  let nextId = 0
  let buffer = ''
  const pending = new Map()

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message && Object.prototype.hasOwnProperty.call(message, 'id') && pending.has(message.id)) {
        const { resolve, timer } = pending.get(message.id)
        clearTimeout(timer)
        pending.delete(message.id)
        resolve(message)
      }
    }
  })

  function write(message) {
    child.stdin.write(JSON.stringify(message) + '\n')
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`RPC timeout after ${timeoutMs}ms: ${method}`))
        }
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      write({ jsonrpc: '2.0', id, method, params })
    })
  }

  function notify(method, params) {
    write({ jsonrpc: '2.0', method, params })
  }

  return { request, notify }
}

async function checkBundleStaticAnalysis() {
  let source
  try {
    source = await fs.readFile(serverPath, 'utf8')
  } catch (error) {
    fail(`dist/server.mjs is not readable: ${error.message}`)
    return
  }
  if (source.trim().length === 0) {
    fail('dist/server.mjs is empty')
    return
  }
  const specs = extractSpecifiers(source)
  const forbidden = [...specs].filter((s) => isBare(s) && isForbidden(s))
  if (forbidden.length > 0) {
    fail(`dist/server.mjs has bare imports of bundled deps: ${forbidden.join(', ')}`)
  } else {
    ok('no bare imports of @modelcontextprotocol/sdk or zod')
  }
}

async function checkRuntimeSmoke(entryPath, label, env = {}) {
  let child
  try {
    child = spawn(process.execPath, [entryPath], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
  } catch (error) {
    fail(`failed to spawn node ${path.relative(root, entryPath)}: ${error.message}`)
    return
  }

  let stderrText = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrText += chunk
  })

  const rpc = createRpc(child, RPC_TIMEOUT_MS)

  const stop = () => {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) child.kill('SIGKILL')
      }, 2000)
    }
  }

  try {
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-bundle-runtime', version: '0.1.0' },
    })
    if (init.error) {
      fail(`initialize returned an error: ${JSON.stringify(init.error)}`)
    } else if (!init.result || !init.result.protocolVersion) {
      fail(`initialize response missing protocolVersion: ${JSON.stringify(init)}`)
    } else {
      ok(
        `${label}: initialize ok (protocol ${init.result.protocolVersion}, server ${
          init.result.serverInfo && init.result.serverInfo.name
        })`,
      )
    }

    rpc.notify('notifications/initialized', {})

    const toolsResponse = await rpc.request('tools/list', {})
    if (toolsResponse.error) {
      fail(`tools/list returned an error: ${JSON.stringify(toolsResponse.error)}`)
    } else {
      const tools = (toolsResponse.result && toolsResponse.result.tools) || []
      const names = tools.map((t) => t.name)
      for (const expected of [
        'subagent_run_task',
        'subagent_run_many',
        'subagent_start',
        'subagent_collect',
        'subagent_watch',
        'subagent_cleanup',
        'subagent_desktop_status',
        'subagent_status_bridge',
        'subagent_status',
        'subagent_cancel',
      ]) {
        if (!names.includes(expected)) {
          fail(`tools/list missing expected tool: ${expected}`)
        }
      }
      if (names.length > 0) {
        ok(`${label}: tools/list ok (${names.length} tools, includes core subagent tools)`)
      } else {
        fail('tools/list returned no tools')
      }
    }
  } catch (error) {
    const tail = stderrText.trim().slice(-500)
    fail(`runtime smoke test failed: ${error.message}${tail ? ` | server stderr: ${tail}` : ''}`)
  } finally {
    stop()
  }
}

async function createLocalUpdateServer() {
  const serverBytes = await fs.readFile(serverPath)
  const serverHash = sha256(serverBytes)
  let baseUrl = ''

  const server = createServer((request, response) => {
    if (request.url === '/server.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end(serverBytes)
      return
    }
    if (request.url === '/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          name: 'subagent-control-protocol',
          version: '999.0.0',
          server: {
            filename: 'server.mjs',
            url: `${baseUrl}/server.mjs`,
            sha256: serverHash,
          },
        }),
      )
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
  return {
    manifestUrl: `${baseUrl}/latest.json`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function checkBootstrapRemoteUpdateSmoke() {
  const updateServer = await createLocalUpdateServer()
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-update-cache-'))
  try {
    await checkRuntimeSmoke(bootstrapPath, 'dist/bootstrap.mjs remote update', {
      SCP_UPDATE_MANIFEST_URL: updateServer.manifestUrl,
      SCP_UPDATE_CACHE_DIR: cacheDir,
    })
    const cachedPath = path.join(cacheDir, '999.0.0', 'server.mjs')
    try {
      await fs.access(cachedPath)
      ok('dist/bootstrap.mjs remote update cached verified server.mjs')
    } catch {
      fail('dist/bootstrap.mjs remote update did not cache server.mjs')
    }
  } finally {
    await updateServer.close()
    await fs.rm(cacheDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('verify-bundle-runtime: checking dist/server.mjs and dist/bootstrap.mjs')

  for (const requiredPath of [serverPath, bootstrapPath]) {
    try {
      await fs.access(requiredPath)
    } catch {
      fail(`${path.relative(root, requiredPath)} does not exist`)
      console.error(`\nverify-bundle-runtime: FAILED (${errors.length} error(s))`)
      process.exit(1)
    }
  }

  const watchdog = setTimeout(() => {
    console.error('\nverify-bundle-runtime: FAILED (overall watchdog timeout)')
    process.exit(1)
  }, WATCHDOG_MS)
  watchdog.unref?.()

  await checkBundleStaticAnalysis()
  await checkRuntimeSmoke(serverPath, 'dist/server.mjs')
  await checkRuntimeSmoke(bootstrapPath, 'dist/bootstrap.mjs', {
    SCP_DISABLE_AUTO_UPDATE: '1',
  })
  await checkBootstrapRemoteUpdateSmoke()

  clearTimeout(watchdog)

  if (errors.length > 0) {
    console.error(`\nverify-bundle-runtime: FAILED (${errors.length} error(s))`)
    process.exit(1)
  }
  console.log('\nverify-bundle-runtime: OK')
}

main().catch((error) => {
  console.error(`\nverify-bundle-runtime: FAILED (uncaught ${error.stack || error.message})`)
  process.exit(1)
})

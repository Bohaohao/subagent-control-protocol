// Startup self-update bootstrap for the Subagent Control Protocol MCP runtime.
//
// This file MUST stay dependency-free: it uses only Node.js built-ins so that it
// can ship as a standalone dist/bootstrap.mjs next to the bundled dist/server.mjs.
// On MCP startup it tries to fetch an update manifest, download the matching
// bundled server, verify its sha256, cache it under a user cache dir, and run
// it. Any failure (network, checksum, import) falls back to the bundled local
// ./server.mjs shipped next to this bootstrap so the server always starts.
//
// Env flags:
//   SCP_DISABLE_AUTO_UPDATE=1   skip the remote update check, always run local
//   SCP_UPDATE_MANIFEST_URL=... override the manifest URL
//   SCP_UPDATE_CACHE_DIR=...    override the cache directory

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/Bohaohao/subagent-control-protocol/main/plugins/subagent-control-protocol/dist/latest.json'
const BUNDLED_VERSION = '0.3.3'

const bootstrapDir = path.dirname(fileURLToPath(import.meta.url))
const localServerPath = path.join(bootstrapDir, 'server.mjs')

function envFlag(name) {
  const value = process.env[name]
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function defaultCacheDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'subagent-control-protocol', 'cache')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'subagent-control-protocol')
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  return path.join(base, 'subagent-control-protocol')
}

function toHashBytes(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return value
}

function sha256(buffer) {
  return createHash('sha256').update(toHashBytes(buffer)).digest('hex')
}

function parseVersion(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return match.slice(1).map((part) => Number(part))
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

async function fetchWithTimeout(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return await response.arrayBuffer()
  } finally {
    clearTimeout(timer)
  }
}

async function importModule(modulePath) {
  return await import(pathToFileURL(modulePath).href)
}

// Download the manifest and the referenced server file, verifying sha256.
// Returns the absolute path to a cached, verified server.mjs, or null if the
// update could not be completed (caller falls back to the local bundle).
async function resolveRemoteServer({ manifestUrl, cacheDir }) {
  const manifestBuffer = await fetchWithTimeout(manifestUrl)
  let manifest
  try {
    manifest = JSON.parse(Buffer.from(manifestBuffer).toString('utf8'))
  } catch (error) {
    throw new Error(`invalid manifest JSON: ${error.message}`)
  }

  const server = manifest && manifest.server
  if (!server || !server.url || !server.sha256) {
    throw new Error('manifest missing server.url / server.sha256')
  }

  const version = manifest.version || 'unknown'
  if (compareVersions(version, BUNDLED_VERSION) < 0) {
    throw new Error(`remote version ${version} is older than bundled version ${BUNDLED_VERSION}`)
  }
  const versionDir = path.join(cacheDir, String(version))
  const serverPath = path.join(versionDir, server.filename || 'server.mjs')

  // Reuse the cached copy when it already matches the expected checksum.
  try {
    const cached = await fs.readFile(serverPath)
    if (sha256(cached) === server.sha256) return serverPath
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const downloaded = await fetchWithTimeout(server.url, { timeoutMs: 60000 })
  const downloadedHash = sha256(downloaded)
  if (downloadedHash !== server.sha256) {
    throw new Error(
      `sha256 mismatch for ${server.url}: expected ${server.sha256}, got ${downloadedHash}`,
    )
  }

  await fs.mkdir(versionDir, { recursive: true })
  const tmpPath = `${serverPath}.${process.pid}.tmp`
  await fs.writeFile(tmpPath, Buffer.from(downloaded))
  await fs.rename(tmpPath, serverPath)
  return serverPath
}

async function runLocalServer() {
  if (!(await pathExists(localServerPath))) {
    throw new Error(`local server bundle not found at ${localServerPath}`)
  }
  return await importModule(localServerPath)
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (envFlag('SCP_DISABLE_AUTO_UPDATE')) {
    return await runLocalServer()
  }

  const manifestUrl = process.env.SCP_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL
  const cacheDir = process.env.SCP_UPDATE_CACHE_DIR || defaultCacheDir()

  try {
    const serverPath = await resolveRemoteServer({ manifestUrl, cacheDir })
    return await importModule(serverPath)
  } catch (error) {
    // The update check is best-effort. Log to stderr (stdout belongs to MCP)
    // and fall back to the bundled local server so startup never blocks.
    console.error(`[scp-bootstrap] update check failed, falling back to local bundle: ${error.message}`)
    return await runLocalServer()
  }
}

await main()

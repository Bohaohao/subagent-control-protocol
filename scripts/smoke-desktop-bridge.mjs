#!/usr/bin/env node
// Desktop bridge smoke test.
//
// Exercises the optional localhost HTTP/SSE status bridge the way an external
// desktop widget would: it starts the bridge through the MCP tool surface, then
// talks to the bridge's HTTP endpoints directly (not through MCP) to verify the
// contract a widget depends on:
//   - GET /health          -> liveness payload
//   - GET /runs            -> list view of recent runs
//   - GET /run/:runId      -> single run view
//   - GET /events          -> bounded incremental event window
//   - GET /events/stream   -> text/event-stream snapshot
//   - bridge discovery file (bridge.json) is written on start and removed on stop
//   - non-loopback bind is rejected without an explicit opt-in
//   - the bridge stops listening after `stop`
//
// The run under the bridge is a dry-run plan so the test stays fast and
// side-effect free while still producing a real events.jsonl for /events and
// /events/stream to surface.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const serverPath = path.join(packageRoot, 'src', 'server.mjs')

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-desktop-bridge-smoke-'))
const outputDir = path.join(tempDir, 'runs')
const discoveryDir = path.join(tempDir, 'discovery')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: packageRoot,
  stderr: 'pipe',
})

const client = new Client({
  name: 'scp-desktop-bridge-smoke',
  version: '0.1.0',
})

// GET a bridge route and parse the JSON body. Rejects on non-2xx, non-JSON, or
// network error so the assertions above each endpoint stay focused on shape.
function httpGetJson(baseUrl, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + pathname, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        let json
        try {
          json = JSON.parse(body)
        } catch (error) {
          return reject(
            new Error(`non-JSON response from ${pathname}: ${body.slice(0, 200)}`),
          )
        }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error(`timeout GET ${pathname}`)))
  })
}

// Open the SSE stream and resolve with the first `data:` event payload, then
// tear the connection down. The bridge emits a snapshot immediately on
// subscribe, so this resolves without waiting for an interval tick.
function readFirstSseEvent(baseUrl, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + pathname, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`SSE ${pathname} returned status ${res.statusCode}`))
      }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        const match = buf.match(/^data: (.+)$/m)
        if (!match) return
        let json
        try {
          json = JSON.parse(match[1])
        } catch (error) {
          res.destroy()
          return reject(new Error(`SSE data was not JSON: ${match[1].slice(0, 200)}`))
        }
        res.destroy()
        resolve(json)
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('timeout waiting for SSE event')))
  })
}

// Resolve true if a connection to the bridge is refused/errored (i.e. nothing
// is listening). Retries briefly because server.close() unbinding the port can
// lag the stop tool's return by a few milliseconds.
async function expectConnectionRefused(baseUrl, pathname) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const refused = await new Promise((resolve) => {
      const req = http.get(baseUrl + pathname, () => resolve(false))
      req.on('error', () => resolve(true))
      req.setTimeout(1000, () => {
        req.destroy()
        resolve(false)
      })
    })
    if (refused) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

try {
  await client.connect(transport)

  // Produce a real (dry-run) run so /runs, /run/:runId, /events, and the SSE
  // stream have a completed run with an events.jsonl to surface.
  const run = await client.callTool({
    name: 'subagent_run_task',
    arguments: {
      workspace: tempDir,
      outputDir,
      id: 'bridge-smoke',
      title: 'Desktop bridge smoke',
      prompt: 'Dry-run execution to seed bridge endpoints with a real run.',
      dryRun: true,
    },
  })
  const runId = run.structuredContent.runSummary.runId
  const runDir = run.structuredContent.runSummary.runDir
  assert.ok(runId, 'dry-run must return a runId for bridge lookups')

  // Non-loopback binds must be rejected unless explicitly opted in. This is the
  // bridge's only access-control boundary (it has no auth), so assert it holds
  // before starting a real bridge.
  const rejected = await client.callTool({
    name: 'subagent_status_bridge',
    arguments: {
      action: 'start',
      host: '0.0.0.0',
      port: 0,
      outputDir,
    },
  })
  assert.equal(
    rejected.structuredContent.ok,
    false,
    'status bridge must reject a non-loopback host by default',
  )
  assert.match(
    rejected.structuredContent.error.message,
    /allowNonLoopback=true/,
    'non-loopback rejection must explain the explicit opt-in flag',
  )

  // Start the bridge on an OS-chosen loopback port, publishing a discovery file
  // into our temp discovery dir so we can assert it without touching user data.
  const start = await client.callTool({
    name: 'subagent_status_bridge',
    arguments: {
      action: 'start',
      port: 0,
      outputDir,
      discoveryDir,
      intervalMs: 500,
      recentEventsLimit: 10,
    },
  })
  assert.equal(start.structuredContent.ok, true, 'status bridge start must report ok=true')
  assert.equal(start.structuredContent.running, true, 'status bridge must report running after start')
  const port = start.structuredContent.port
  assert.equal(typeof port, 'number', 'status bridge must expose a numeric port')
  assert.ok(port > 0, 'status bridge must bind a real port')
  const base = `http://127.0.0.1:${port}`

  // /health: liveness. A widget polls this to know the bridge is up.
  const health = await httpGetJson(base, '/health')
  assert.equal(health.status, 200, '/health must respond 200')
  assert.equal(health.json.ok, true, '/health payload must report ok=true')
  assert.equal(health.json.schema, 'scp.bridge-health/v1', '/health must carry the bridge-health schema tag')

  // /runs: the list view a widget renders as its run list.
  const runs = await httpGetJson(base, '/runs')
  assert.equal(runs.status, 200, '/runs must respond 200')
  assert.equal(runs.json.view.schema, 'scp.run-view/v1', '/runs must carry the run-view schema tag')
  assert.ok(Array.isArray(runs.json.view.runs), '/runs view must expose a runs array')
  assert.ok(
    runs.json.view.runs.some((entry) => entry.runId === runId),
    '/runs must include the smoke run',
  )

  // /run/:runId: the single-run view a widget drills into.
  const oneRun = await httpGetJson(base, `/run/${encodeURIComponent(runId)}`)
  assert.equal(oneRun.status, 200, '/run/:runId must respond 200')
  assert.equal(oneRun.json.view.runId, runId, '/run/:runId must resolve the requested run')
  assert.equal(oneRun.json.view.schema, 'scp.run-view/v1')

  // /events: bounded incremental event window for a run.
  const events = await httpGetJson(
    base,
    `/events?runId=${encodeURIComponent(runId)}&limit=20`,
  )
  assert.equal(events.status, 200, '/events must respond 200')
  assert.equal(events.json.ok, true, '/events payload must report ok=true')
  assert.equal(events.json.schema, 'scp.bridge-events/v1', '/events must carry the bridge-events schema tag')
  assert.ok(Array.isArray(events.json.events), '/events must return an events array')
  assert.ok(events.json.events.length > 0, '/events must surface the dry-run lifecycle')
  assert.ok(
    events.json.events.every((event) => event.timestamp),
    'every bridged event must carry a timestamp',
  )

  // /events/stream: SSE snapshot pushed on subscribe. A widget opens this for
  // live updates; assert the first frame is a snapshot carrying a run view.
  const sse = await readFirstSseEvent(base, '/events/stream')
  assert.equal(sse.type, 'snapshot', 'SSE first frame must be a snapshot')
  assert.ok(sse.view, 'SSE snapshot must carry a view')
  assert.equal(sse.view.schema, 'scp.run-view/v1', 'SSE snapshot view must carry the run-view schema tag')

  // Discovery file: a widget reads <discoveryDir>/bridge.json to find the
  // host/port without scraping. Assert it exists with the bridge's facts.
  const discoveryPath = path.join(discoveryDir, 'bridge.json')
  const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'))
  assert.equal(discovery.schema, 'scp.bridge-discovery/v1', 'discovery file must carry the bridge-discovery schema tag')
  assert.equal(discovery.host, '127.0.0.1', 'discovery file must record the loopback host')
  assert.equal(discovery.port, port, 'discovery file must record the bound port')
  assert.equal(typeof discovery.startedAt, 'string', 'discovery file must record a startedAt timestamp')
  assert.equal(typeof discovery.pid, 'number', 'discovery file must record a pid')

  // The status action must surface the same discovery file so a controller can
  // locate the bridge without reading the filesystem directly.
  const status = await client.callTool({
    name: 'subagent_status_bridge',
    arguments: { action: 'status' },
  })
  assert.equal(status.structuredContent.ok, true, 'status action must report ok=true')
  assert.equal(status.structuredContent.running, true, 'status must report running while the bridge is up')
  assert.equal(status.structuredContent.discovery?.port, port, 'status must surface the discovery file port')

  // Stop the bridge: it must unbind and remove the discovery file so widgets
  // stop seeing a stale endpoint.
  const stop = await client.callTool({
    name: 'subagent_status_bridge',
    arguments: { action: 'stop' },
  })
  assert.equal(stop.structuredContent.ok, true, 'status bridge stop must report ok=true')
  assert.equal(stop.structuredContent.running, false, 'status bridge must report stopped after stop')

  const discoveryGone = await fs
    .access(discoveryPath)
    .then(() => false)
    .catch(() => true)
  assert.ok(discoveryGone, 'discovery file must be removed when the bridge stops')

  const refused = await expectConnectionRefused(base, '/health')
  assert.ok(refused, 'bridge must stop listening after stop')

  console.log(
    JSON.stringify({ ok: true, runId, runDir, port, discoveryDir }, null, 2),
  )
} finally {
  await transport.close().catch(() => {})
  await fs.rm(tempDir, { recursive: true, force: true })
}

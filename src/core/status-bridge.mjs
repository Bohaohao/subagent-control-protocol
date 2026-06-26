// Localhost status bridge for subagent-control-protocol.
//
// A tiny, dependency-free HTTP/SSE server that exposes SCP status snapshots to
// a future desktop widget. It intentionally knows nothing about the scheduler:
// callers inject provider functions (getHealth/getRuns/getRun/getEvents/
// subscribe) so the bridge stays decoupled and side-effect free until
// startStatusBridge is called. Uses only Node builtins (node:http).
//
// Routes:
//   GET /health           -> provider.getHealth()
//   GET /runs             -> provider.getRuns()
//   GET /run/:runId       -> provider.getRun(runId)
//   GET /events           -> provider.getEvents(query)
//   GET /events/stream    -> text/event-stream fed by provider.subscribe()
//
// The /events query string is parsed into scalar values and passed through to
// the provider verbatim; the bridge never reads scheduler internals. It also
// normalizes the incremental-event consumer params so providers do not have to:
//   afterSequence - integer cursor (events with sequence > this), or null
//   since         - ISO timestamp lower bound (passed through as a string)
//   limit         - max events to return (kept as a string for back-compat)
//
// The handle exposes runtime stats (startedAt, host, port, current SSE client
// count, total connections accepted) via handle.getStats() so a desktop widget
// can show bridge liveness without probing scheduler state.
//
// Default bind is 127.0.0.1:17361 (localhost only). Non-loopback binds are
// rejected unless explicitly allowed because this bridge intentionally has no
// authentication. All JSON responses are written safely (no thrown provider
// error leaks internals; errors become a 502 with a short message). SSE
// connections are cleaned up on client disconnect and on stopStatusBridge.

import http from 'node:http'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 17361
const HEARTBEAT_INTERVAL_MS = 15_000 // SSE keep-alive comment cadence

// Routes are matched as [method, regex, handler]. The first match wins, so keep
// more specific paths above prefixes they overlap with (e.g. /events/stream
// before /events).
const ROUTES = [
  ['GET', /^\/health\/?$/, handleHealth],
  ['GET', /^\/runs\/?$/, handleRuns],
  ['GET', /^\/run\/([^/]+)\/?$/, handleRun],
  ['GET', /^\/events\/stream\/?$/, handleEventsStream],
  ['GET', /^\/events\/?$/, handleEvents],
]

// --- Public API -------------------------------------------------------------

// Start the status bridge. Returns a handle { server, port, host, close } that
// stopStatusBridge accepts. `input` may be an options object or (for symmetry
// with the provider) carry the providers under input.providers.
//
// options:
//   host     - bind host (default 127.0.0.1)
//   port     - bind port (default 17361); 0 lets the OS choose
//   allowNonLoopback - allow binding to non-loopback interfaces (default false)
//   providers - { getHealth, getRuns, getRun, getEvents, subscribe }
//               each optional; a missing provider yields a 501 for its route.
export function startStatusBridge(input = {}) {
  const options = normalizeOptions(input)
  const providers = options.providers || {}

  const subscribers = new Set()
  const state = { server: null, closing: false }
  // Runtime stats: totalConnections counts every SSE client ever accepted
  // (monotonic); current client count is just subscribers.size. startedAt is
  // captured once so getStats() stays stable across the bridge's lifetime.
  const stats = { totalConnections: 0 }
  const startedAt = new Date().toISOString()
  const ctx = { subscribers, stats, state }

  const server = http.createServer((req, res) => onRequest(req, res, providers, ctx))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : options.port
      const handle = {
        server,
        host: options.host,
        port,
        startedAt,
        subscribers,
        stats,
        // Snapshot of bridge runtime stats for a desktop widget. Returns plain
        // values only (no live references) so the caller can serialize it.
        getStats: () => ({
          startedAt,
          host: options.host,
          port,
          sseClientCount: subscribers.size,
          totalConnections: stats.totalConnections,
        }),
        close: () => stopStatusBridge(handle),
      }
      state.server = server
      resolve(handle)
    })
  })
}

// Stop the bridge: close the HTTP server and detach every SSE listener from the
// provider so the bridge stops pushing events. Tolerates repeated calls and a
// partially-constructed handle; calling stop twice (or after a failed start)
// resolves without throwing.
export function stopStatusBridge(handle) {
  if (!handle) return Promise.resolve()
  // A handle with no server (e.g. start rejected) has nothing to clean up.
  if (!handle.server) return Promise.resolve()
  if (handle._closing) return Promise.resolve()
  handle._closing = true

  // Detach SSE subscribers so the provider can stop notifying them. End the
  // underlying responses so clients see the connection close promptly. Copy to
  // an array first because detachSubscriber mutates the Set during iteration.
  if (handle.subscribers) {
    for (const sub of Array.from(handle.subscribers)) {
      detachSubscriber(handle.subscribers, sub)
      safeEnd(sub.response)
    }
    handle.subscribers.clear()
  }

  return new Promise((resolve) => {
    handle.server.close(() => resolve())
    // close() only waits for in-flight connections to finish; SSE keeps them
    // open, so force-destroy any that linger after the detach above.
    handle.server.closeAllConnections?.()
  })
}

// --- Options & providers ----------------------------------------------------

function normalizeOptions(input) {
  const opts = typeof input === 'object' && input !== null ? input : {}
  const providers = opts.providers && typeof opts.providers === 'object' ? opts.providers : null
  const host = typeof opts.host === 'string' && opts.host.length ? opts.host : DEFAULT_HOST
  if (!isLoopbackHost(host) && opts.allowNonLoopback !== true) {
    throw new Error('status bridge refuses non-loopback host without allowNonLoopback=true')
  }
  return {
    host,
    port: Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT,
    allowNonLoopback: opts.allowNonLoopback === true,
    providers: providers || extractProviders(opts),
  }
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase()
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]'
}

// Allow callers to pass provider functions directly at the top level of options
// (e.g. startStatusBridge({ getHealth, subscribe })) for ergonomics.
function extractProviders(opts) {
  const names = ['getHealth', 'getRuns', 'getRun', 'getEvents', 'subscribe']
  const providers = {}
  let found = false
  for (const name of names) {
    if (typeof opts[name] === 'function') {
      providers[name] = opts[name]
      found = true
    }
  }
  return found ? providers : null
}

// --- Request dispatch -------------------------------------------------------

function onRequest(req, res, providers, ctx) {
  if (ctx.state.closing) {
    return sendJson(res, 503, { error: 'bridge closing' })
  }
  const url = safeParseUrl(req.url)
  for (const [method, regex, handler] of ROUTES) {
    if (req.method !== method) continue
    const match = regex.exec(url.pathname)
    if (!match) continue
    try {
      return handler(req, res, providers, ctx, match, url)
    } catch (err) {
      return sendJson(res, 502, { error: shortError(err) })
    }
  }
  sendJson(res, 404, { error: 'not found' })
}

// --- Route handlers ---------------------------------------------------------

function handleHealth(req, res, providers) {
  return callProvider(res, providers, 'getHealth', () => [])
}

function handleRuns(req, res, providers) {
  return callProvider(res, providers, 'getRuns', () => [])
}

function handleRun(req, res, providers, _ctx, match) {
  const runId = safeDecodeURIComponent(match[1] || '')
  if (runId === null) return sendJson(res, 400, { error: 'malformed runId' })
  if (!runId) return sendJson(res, 400, { error: 'missing runId' })
  return callProvider(res, providers, 'getRun', () => [runId])
}

function handleEvents(req, res, providers, _ctx, _match, url) {
  const query = parseQuery(url.searchParams)
  return callProvider(res, providers, 'getEvents', () => [query])
}

function handleEventsStream(req, res, providers, ctx) {
  if (typeof providers.subscribe !== 'function') {
    return sendJson(res, 501, { error: 'subscribe provider not configured' })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const { subscribers, stats } = ctx
  const sub = { response: res, heartbeat: null }
  subscribers.add(sub)
  // Count every accepted SSE client so getStats() can report lifetime traffic
  // even after clients disconnect.
  stats.totalConnections += 1

  // Keep the connection alive even when no events flow; lets proxies/clients
  // detect a dead bridge without buffering real events.
  sub.heartbeat = setInterval(() => writeSseComment(res, 'ping'), HEARTBEAT_INTERVAL_MS)

  const detach = () => detachSubscriber(subscribers, sub)
  req.on('close', detach)
  res.on('close', detach)
  res.on('error', detach)

  // The listener is the single entry point the provider calls with each event.
  // We coerce to a safe JSON payload so a bad value never breaks the stream.
  const listener = (event) => writeSseEvent(res, event)
  try {
    const unsub = providers.subscribe(listener)
    sub.unsubscribe = typeof unsub === 'function' ? unsub : null
  } catch (err) {
    writeSseEvent(res, { type: 'error', message: shortError(err) })
    detach()
  }
}

// --- Provider invocation ----------------------------------------------------

// Call a provider function with the given args, awaiting it if it returns a
// promise, and write the result as JSON. Handles missing providers (501),
// provider throws (502), and null results (200 with null body).
async function callProvider(res, providers, name, argsFn) {
  const fn = providers && providers[name]
  if (typeof fn !== 'function') {
    return sendJson(res, 501, { error: `${name} provider not configured` })
  }
  let result
  try {
    result = await fn(...argsFn())
  } catch (err) {
    return sendJson(res, 502, { error: shortError(err) })
  }
  return sendJson(res, 200, result)
}

// --- SSE helpers ------------------------------------------------------------

function writeSseEvent(res, event) {
  const payload = toSafeJson(event)
  if (payload === null) return // never emit malformed data
  res.write(`data: ${payload}\n\n`)
}

function writeSseComment(res, text) {
  res.write(`: ${text}\n\n`)
}

function detachSubscriber(subscribers, sub) {
  if (!sub) return
  if (sub.heartbeat) {
    clearInterval(sub.heartbeat)
    sub.heartbeat = null
  }
  if (typeof sub.unsubscribe === 'function') {
    try {
      sub.unsubscribe()
    } catch {
      // Provider cleanup is best-effort; ignore failures here.
    }
    sub.unsubscribe = null
  }
  subscribers.delete(sub)
}

// --- Response & parsing helpers --------------------------------------------

function sendJson(res, status, body) {
  const json = toSafeJson(body)
  if (json === null) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end('{"error":"internal serialization error"}')
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(json)
}

function safeParseUrl(raw) {
  try {
    return new URL(raw, 'http://localhost')
  } catch {
    return new URL('/', 'http://localhost')
  }
}

// Parse the query string into scalar values for the provider. Only the first
// occurrence of each key is kept so the provider contract stays a simple
// string map. The incremental-event consumer params are then normalized so
// providers do not have to re-parse them:
//   afterSequence -> integer cursor (events with sequence > this), or null
//   since         -> raw string lower-bound (typically an ISO timestamp)
//   limit         -> kept as a string to preserve the existing provider contract
// The bridge itself never interprets these beyond coercion; it does not read
// scheduler internals.
function parseQuery(searchParams) {
  const query = {}
  for (const [key, value] of searchParams.entries()) {
    if (query[key] === undefined) query[key] = value
  }
  if (query.afterSequence !== undefined) {
    query.afterSequence = parseInteger(query.afterSequence)
  }
  if (query.since !== undefined) {
    query.since = String(query.since)
  }
  return query
}

function parseInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function toSafeJson(value) {
  try {
    return JSON.stringify(value === undefined ? null : value)
  } catch {
    try {
      return JSON.stringify({ error: 'unprocessable value' })
    } catch {
      return null
    }
  }
}

function shortError(err) {
  if (!err) return 'unknown error'
  const msg = typeof err === 'string' ? err : err.message
  return typeof msg === 'string' && msg.length ? msg : 'unknown error'
}

function safeEnd(res) {
  try {
    res.end()
  } catch {
    // Connection may already be closed; ignore.
  }
}

export { DEFAULT_HOST, DEFAULT_PORT }

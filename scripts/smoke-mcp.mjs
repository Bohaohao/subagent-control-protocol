#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const serverPath = path.join(packageRoot, 'src', 'server.mjs')

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-mcp-smoke-'))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: packageRoot,
  stderr: 'pipe',
})

const client = new Client({
  name: 'subagent-control-protocol-smoke',
  version: '0.2.0',
})

// Locate the eventLogPath across the shapes the implementation may use for
// event summaries: the single task result, run-summary task entries, or a
// taskEvents / summary.tasks collection. Returns the first path found or null.
function findEventLogPath(runSummary, result) {
  if (result?.eventLogPath) return result.eventLogPath
  const tasks =
    runSummary?.tasks || runSummary?.taskEvents || runSummary?.summary?.tasks
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (task?.eventLogPath) return task.eventLogPath
    }
  }
  if (runSummary?.eventLogPath) return runSummary.eventLogPath
  return null
}

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, 'utf8')
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

try {
  await client.connect(transport)

  const tools = await client.listTools()
  assert.ok(tools.tools.some((tool) => tool.name === 'subagent_run_task'))
  assert.ok(tools.tools.some((tool) => tool.name === 'subagent_run_many'))
  assert.ok(tools.tools.some((tool) => tool.name === 'subagent_status'))

  const run = await client.callTool({
    name: 'subagent_run_task',
    arguments: {
      workspace: tempDir,
      outputDir: path.join(tempDir, 'runs'),
      id: 'smoke',
      title: 'MCP dry-run smoke',
      prompt: 'Confirm that dry-run execution returns a structured result.',
      dryRun: true,
    },
  })

  assert.equal(run.structuredContent.result.status, 'completed')
  assert.equal(run.structuredContent.runSummary.totalTasks, 1)

  // Event artifact behavior (first-priority observability): a dry-run must
  // write and return an eventLogPath pointing at the run's events.jsonl. The
  // implementation may surface event summaries on the single task result, on
  // the run-summary task entries, or under a taskEvents / summary.tasks
  // collection — look in all of those rather than assuming one location.
  const eventLogPath = findEventLogPath(
    run.structuredContent.runSummary,
    run.structuredContent.result,
  )
  assert.ok(eventLogPath, 'dry-run result must return an eventLogPath (events.jsonl)')
  assert.ok(
    eventLogPath.endsWith('events.jsonl'),
    `eventLogPath must point at events.jsonl, got: ${eventLogPath}`,
  )
  const runDir = run.structuredContent.runSummary.runDir
  assert.ok(
    path.resolve(eventLogPath).startsWith(path.resolve(runDir) + path.sep),
    'eventLogPath must live inside the run directory',
  )
  // "writes" the artifact: events.jsonl should exist on disk after a dry-run.
  const eventLogExists = await fs
    .access(eventLogPath)
    .then(() => true)
    .catch(() => false)
  assert.ok(eventLogExists, `dry-run must write the events.jsonl artifact at ${eventLogPath}`)
  const events = await readJsonLines(eventLogPath)
  assert.ok(events.every((event) => event.timestamp), 'every event must include timestamp')
  assert.ok(events.some((event) => event.type === 'task_started' && event.taskId === 'smoke'))
  assert.ok(
    events.some((event) =>
      event.type === 'task_completed' && event.taskId === 'smoke' && event.status === 'completed',
    ),
    'events.jsonl must include a completed terminal event for the smoke task',
  )

  const statusResult = await client.callTool({
    name: 'subagent_status',
    arguments: {
      runDir,
      recentEventsLimit: 5,
    },
  })
  const status = statusResult.structuredContent

  assert.equal(status.summary.runId, run.structuredContent.runSummary.runId)

  // subagent_status exposes event-aware fields (latest heartbeat / phase /
  // recent events) when present. They are optional for legacy or incomplete
  // runs, so only assert their shape — never their presence. Event summaries
  // may live on the task result, a top-level taskEvents list, or a recentEvents
  // window; tolerate whichever the implementation provides.
  const statusTask = status.summary?.tasks?.[0] || {}
  for (const field of ['eventLogPath', 'lastHeartbeatAt', 'lastEventAt']) {
    if (statusTask[field] !== undefined) {
      assert.equal(
        typeof statusTask[field],
        'string',
        `status task ${field} must be a string when present`,
      )
    }
  }
  // The per-task event summary (attached inline and/or under taskEvents) carries
  // the latest phase/heartbeat; assert shape only, when present.
  const inlineEvents = statusTask.events
  const taskEventsEntry = Array.isArray(status.taskEvents)
    ? status.taskEvents.find((entry) => entry?.taskId === statusTask.id)
    : null
  for (const eventSummary of [inlineEvents, taskEventsEntry]) {
    if (!eventSummary) continue
    assert.equal(typeof eventSummary, 'object', 'task event summary must be an object')
    if (eventSummary.eventLogPath !== undefined) {
      assert.equal(
        path.resolve(eventSummary.eventLogPath),
        path.resolve(eventLogPath),
        'status task event summary eventLogPath must match the run result eventLogPath',
      )
    }
    for (const field of ['lastHeartbeatAt', 'lastEventAt', 'phase']) {
      if (eventSummary[field] !== undefined) {
        assert.equal(
          typeof eventSummary[field],
          'string',
          `task event summary ${field} must be a string when present`,
        )
      }
    }
  }
  // recentEvents, when surfaced, is a bounded array of trimmed event entries.
  if (status.recentEvents !== undefined) {
    assert.ok(Array.isArray(status.recentEvents), 'recentEvents must be an array when present')
    assert.ok(status.recentEvents.length <= 5, 'recentEventsLimit must bound the returned event window')
  }

  const listStatus = await client.callTool({
    name: 'subagent_status',
    arguments: {
      outputDir: path.join(tempDir, 'runs'),
      limit: 10,
    },
  })
  assert.equal(listStatus.structuredContent.mode, 'list')
  assert.ok(
    listStatus.structuredContent.statusEvents?.runsWithEventLogs >= 1,
    'list mode should expose compact event metadata',
  )

  const summaryPath = path.join(runDir, 'run-summary.json')
  const summaryBackupPath = path.join(runDir, 'run-summary.json.bak')
  await fs.rename(summaryPath, summaryBackupPath)
  try {
    const fallbackStatus = await client.callTool({
      name: 'subagent_status',
      arguments: {
        runDir,
        recentEventsLimit: 5,
      },
    })
    assert.equal(fallbackStatus.structuredContent.mode, 'single')
    assert.equal(fallbackStatus.structuredContent.summary.runId, path.basename(runDir))
    assert.ok(
      Array.isArray(fallbackStatus.structuredContent.taskEvents),
      'in-progress fallback should still expose taskEvents',
    )
  } finally {
    await fs.rename(summaryBackupPath, summaryPath)
  }

  // --- Second-layer async start/collect workflow -----------------------------
  // The async layer splits plan dispatch from result collection so the
  // controller can start a plan and poll for completion instead of blocking:
  //   subagent_start   -> kicks off a plan in the background and returns
  //                       { ok, runId, runDir, status } without blocking.
  //   subagent_collect -> polls a started run; returns { ok, done, runSummary }
  //                       where `done` flips true once the run has settled.
  // The contract asserted below is what the scheduler/server async
  // implementation must satisfy. The dry-run plan keeps it fast and side-effect
  // free, and the assertions stay permissive about where optional fields live
  // (mirroring the status tool's tolerant shape handling above).
  assert.ok(tools.tools.some((tool) => tool.name === 'subagent_start'))
  assert.ok(tools.tools.some((tool) => tool.name === 'subagent_collect'))

  const asyncOutputDir = path.join(tempDir, 'async-runs')
  const start = await client.callTool({
    name: 'subagent_start',
    arguments: {
      workspace: tempDir,
      outputDir: asyncOutputDir,
      concurrency: 1,
      dryRun: true,
      tasks: [
        {
          id: 'async-smoke',
          title: 'MCP async dry-run smoke',
          prompt: 'Confirm that async dry-run execution returns a structured result.',
        },
      ],
    },
  })
  const startPayload = start.structuredContent
  assert.equal(startPayload.ok, true, 'subagent_start must report ok=true')
  assert.equal(typeof startPayload.runId, 'string', 'subagent_start must return runId as a string')
  assert.ok(startPayload.runId.length > 0, 'subagent_start must return a non-empty runId')
  assert.equal(typeof startPayload.runDir, 'string', 'subagent_start must return runDir as a string')
  assert.ok(startPayload.runDir.length > 0, 'subagent_start must return a non-empty runDir')
  // A non-error start status: any string that is not a terminal failure. The
  // exact value (e.g. "started" / "running") is implementation-defined.
  assert.equal(typeof startPayload.status, 'string', 'subagent_start must return a status string')
  assert.ok(
    !['failed', 'error', 'cancelled'].includes(startPayload.status),
    `subagent_start status must not be an error status, got: ${startPayload.status}`,
  )

  // Poll subagent_collect until the run settles. Dry-run plans complete almost
  // immediately, so a short bounded loop is enough; bail out defensively if the
  // implementation never flips `done` so the assertion below reports it clearly.
  const asyncRunId = startPayload.runId
  const asyncRunDir = startPayload.runDir
  let collect
  const maxAttempts = 20
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    collect = await client.callTool({
      name: 'subagent_collect',
      arguments: { runId: asyncRunId, runDir: asyncRunDir },
    })
    if (collect.structuredContent.done === true) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const collectPayload = collect.structuredContent
  assert.equal(collectPayload.ok, true, 'subagent_collect must report ok=true')
  assert.equal(
    collectPayload.done,
    true,
    'subagent_collect must report done=true once the run settles',
  )

  // runSummary may be surfaced as `runSummary` (full summary) or `summary`
  // (alias); tolerate either, mirroring the status tool's permissive shape.
  const asyncSummary = collectPayload.runSummary || collectPayload.summary
  assert.ok(asyncSummary, 'subagent_collect must return a runSummary/summary when done')
  assert.equal(asyncSummary.totalTasks, 1, 'async dry-run plan must report exactly one task')
  assert.equal(asyncSummary.runId, asyncRunId, 'collect runSummary runId must match start runId')

  const collectByRunId = await client.callTool({
    name: 'subagent_collect',
    arguments: { runId: asyncRunId },
  })
  assert.equal(collectByRunId.structuredContent.ok, true, 'subagent_collect runId-only must report ok=true')
  assert.equal(collectByRunId.structuredContent.done, true, 'subagent_collect runId-only must resolve completed runs')
  assert.equal(
    (collectByRunId.structuredContent.runSummary || collectByRunId.structuredContent.summary).runId,
    asyncRunId,
    'subagent_collect runId-only summary runId must match start runId',
  )

  // Event/status data must remain readable through the async path: locate the
  // run's events.jsonl (on the summary, its task entries, or a nested
  // summary.tasks collection) and confirm it carries the dry-run lifecycle.
  const asyncEventLogPath = findEventLogPath(asyncSummary, null)
  assert.ok(asyncEventLogPath, 'async collect must surface an eventLogPath (events.jsonl)')
  assert.ok(
    asyncEventLogPath.endsWith('events.jsonl'),
    `async eventLogPath must point at events.jsonl, got: ${asyncEventLogPath}`,
  )
  assert.ok(
    path.resolve(asyncEventLogPath).startsWith(path.resolve(asyncRunDir) + path.sep),
    'async eventLogPath must live inside the run directory',
  )
  const asyncEvents = await readJsonLines(asyncEventLogPath)
  assert.ok(asyncEvents.every((event) => event.timestamp), 'every async event must include timestamp')
  assert.ok(
    asyncEvents.some((event) => event.type === 'task_started' && event.taskId === 'async-smoke'),
    'async events.jsonl must include a task_started event for the async-smoke task',
  )

  // The status tool must also still resolve the async run directory.
  const asyncStatus = await client.callTool({
    name: 'subagent_status',
    arguments: { runDir: asyncRunDir, recentEventsLimit: 5 },
  })
  assert.equal(asyncStatus.structuredContent.mode, 'single')
  assert.equal(asyncStatus.structuredContent.summary.runId, asyncRunId)

  console.log(
    JSON.stringify(
      { ok: true, runDir, eventLogPath, asyncRunDir, asyncEventLogPath },
      null,
      2,
    ),
  )
} finally {
  await transport.close()
  await fs.rm(tempDir, { recursive: true, force: true })
}

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

  const status = await client.callTool({
    name: 'subagent_status',
    arguments: {
      runDir: run.structuredContent.runSummary.runDir,
    },
  })

  assert.equal(status.structuredContent.summary.runId, run.structuredContent.runSummary.runId)
  console.log(JSON.stringify({ ok: true, runDir: run.structuredContent.runSummary.runDir }, null, 2))
} finally {
  await transport.close()
  await fs.rm(tempDir, { recursive: true, force: true })
}

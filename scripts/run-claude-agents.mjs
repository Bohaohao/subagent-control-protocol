#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultSchemaPath = path.join(kitRoot, 'schemas', 'agent-result.schema.json')

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.plan) {
    printHelp()
    process.exit(args.help ? 0 : 1)
  }

  const planPath = path.resolve(String(args.plan))
  const planDir = path.dirname(planPath)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assertPlanShape(plan)

  const workspace = path.resolve(planDir, String(args.workspace || plan.workspace || '.'))
  const outputDir = path.resolve(planDir, String(args.out || plan.outputDir || path.join(workspace, '.agent-runs')))
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = path.join(outputDir, runId)
  const concurrency = Number(args.concurrency || plan.concurrency || 1)
  const dryRun = Boolean(args['dry-run'])
  const claudeExecutable = await resolveClaudeExecutable(args.claude || process.env.CLAUDE_BIN)

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('--concurrency must be a positive integer')
  }

  await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true })

  const schema = JSON.parse(await fs.readFile(resultSchemaPath, 'utf8'))
  const tasks = plan.tasks.map((task) => normalizeTask(task, plan.defaults || {}, workspace, planDir))
  validateDependencies(tasks)

  const scheduler = {
    runId,
    runDir,
    workspace,
    concurrency,
    dryRun,
    schema,
    claudeExecutable,
    startedAt: new Date().toISOString(),
    endedAt: null,
    maxParallelObserved: 0,
    results: [],
  }

  await writeJson(path.join(runDir, 'run-input.json'), {
    planPath,
    workspace,
    concurrency,
    dryRun,
    taskCount: tasks.length,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      kind: task.kind,
      dependsOn: task.dependsOn,
      timeoutMs: task.timeoutMs,
    })),
  })

  const results = await runTasks(tasks, scheduler)
  scheduler.endedAt = new Date().toISOString()
  scheduler.results = results

  const summary = {
    runId: scheduler.runId,
    startedAt: scheduler.startedAt,
    endedAt: scheduler.endedAt,
    workspace: scheduler.workspace,
    concurrency: scheduler.concurrency,
    maxParallelObserved: scheduler.maxParallelObserved,
    dryRun: scheduler.dryRun,
    totalTasks: tasks.length,
    completedTasks: results.filter((r) => r.status === 'completed').length,
    partialTasks: results.filter((r) => r.status === 'partial').length,
    blockedTasks: results.filter((r) => r.status === 'blocked').length,
    failedTasks: results.filter((r) => r.status === 'failed').length,
    skippedTasks: results.filter((r) => r.status === 'skipped').length,
    timedOutTasks: results.filter((r) => r.status === 'timed_out').length,
    tasks: results,
  }

  await writeJson(path.join(runDir, 'run-summary.json'), summary)
  process.stdout.write(JSON.stringify(summary, null, 2) + os.EOL)

  if (summary.failedTasks || summary.timedOutTasks || summary.blockedTasks) {
    process.exitCode = 1
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') {
      out.help = true
      continue
    }
    if (!token.startsWith('--')) {
      continue
    }
    const eq = token.indexOf('=')
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-claude-agents.mjs --plan PLAN.json [--concurrency 2] [--dry-run]

Options:
  --plan PATH         Task plan JSON file.
  --workspace PATH    Override plan workspace.
  --out PATH          Override output directory.
  --concurrency N     Max parallel Claude tasks.
  --claude PATH       Override Claude executable.
  --dry-run           Write prompts and commands without invoking Claude.
`)
}

function assertPlanShape(plan) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Invalid plan: expected { version: 1, tasks: [...] }')
  }
}

function normalizeTask(task, defaults, workspace, planDir) {
  if (!task.id || !/^[A-Za-z0-9._-]+$/.test(task.id)) {
    throw new Error(`Invalid task id: ${task.id}`)
  }
  if (!task.title || !task.prompt) {
    throw new Error(`Task ${task.id} must include title and prompt`)
  }

  const merged = { ...defaults, ...task }
  const addDirs = unique([workspace, ...(defaults.addDirs || []), ...(task.addDirs || [])])
    .map((dir) => path.resolve(planDir, dir))

  return {
    id: task.id,
    title: task.title,
    kind: task.kind || 'other',
    prompt: task.prompt,
    dependsOn: task.dependsOn || [],
    model: merged.model,
    effort: merged.effort,
    timeoutMs: Number(merged.timeoutMs || 600000),
    maxBudgetUsd: merged.maxBudgetUsd,
    permissionMode: merged.permissionMode || 'default',
    addDirs,
    allowedTools: merged.allowedTools || [],
    disallowedTools: merged.disallowedTools || [],
    tools: merged.tools,
    systemPrompt: merged.systemPrompt || '',
    workspace,
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function validateDependencies(tasks) {
  const ids = new Set(tasks.map((task) => task.id))
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Task ${task.id} depends on missing task ${dep}`)
      }
    }
  }
}

async function runTasks(tasks, scheduler) {
  const pending = new Map(tasks.map((task) => [task.id, task]))
  const running = new Map()
  const finished = new Map()
  const results = []

  while (pending.size || running.size) {
    let startedAny = false

    for (const [taskId, task] of pending) {
      if (running.size >= scheduler.concurrency) break

      const depResults = task.dependsOn.map((depId) => finished.get(depId)).filter(Boolean)
      if (depResults.length !== task.dependsOn.length) continue

      const failedDep = depResults.find((r) => !['completed', 'partial'].includes(r.status))
      if (failedDep) {
        const skipped = await writeSkippedTask(task, scheduler, failedDep)
        pending.delete(taskId)
        finished.set(taskId, skipped)
        results.push(skipped)
        startedAny = true
        continue
      }

      pending.delete(taskId)
      const promise = runOneTask(task, scheduler)
      running.set(taskId, promise)
      scheduler.maxParallelObserved = Math.max(scheduler.maxParallelObserved, running.size)
      startedAny = true
    }

    if (!running.size) {
      if (!startedAny && pending.size) {
        throw new Error('No runnable tasks remain; check dependency cycles')
      }
      continue
    }

    const completed = await Promise.race(
      [...running.entries()].map(([taskId, promise]) =>
        promise.then((result) => ({ taskId, result }))
      )
    )
    running.delete(completed.taskId)
    finished.set(completed.taskId, completed.result)
    results.push(completed.result)
  }

  return results.sort((a, b) => tasks.findIndex((t) => t.id === a.id) - tasks.findIndex((t) => t.id === b.id))
}

async function writeSkippedTask(task, scheduler, failedDep) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  await fs.mkdir(taskDir, { recursive: true })
  const result = {
    id: task.id,
    title: task.title,
    status: 'skipped',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    taskDir,
    reason: `Dependency ${failedDep.id} ended with status ${failedDep.status}`,
  }
  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

async function runOneTask(task, scheduler) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  await fs.mkdir(taskDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const prompt = buildPrompt(task)
  const command = buildClaudeCommand(task, scheduler.schema, scheduler.claudeExecutable)

  await fs.writeFile(path.join(taskDir, 'prompt.md'), prompt, 'utf8')
  await writeJson(path.join(taskDir, 'task.json'), {
    id: task.id,
    title: task.title,
    kind: task.kind,
    dependsOn: task.dependsOn,
    command: command.display,
    timeoutMs: task.timeoutMs,
    cwd: task.workspace,
  })

  if (scheduler.dryRun) {
    const dryResult = {
      id: task.id,
      title: task.title,
      status: 'completed',
      startedAt,
      endedAt: new Date().toISOString(),
      taskDir,
      exitCode: 0,
      timedOut: false,
      parsed: {
        status: 'completed',
        summary: 'Dry run only; Claude was not invoked.',
        filesChanged: [],
        commandsRun: [],
        verification: [{ check: 'dry-run', status: 'passed', evidence: command.display }],
        risks: [],
        nextSteps: [],
      },
    }
    await writeJson(path.join(taskDir, 'result.json'), dryResult)
    return dryResult
  }

  const execution = await spawnClaude(command.executable, command.args, prompt, task.workspace, task.timeoutMs, taskDir)
  const rawPath = path.join(taskDir, 'raw-output.json')
  const raw = safeJsonParse(execution.stdout)
  await writeJson(rawPath, raw.ok ? raw.value : { parseError: raw.error, stdout: execution.stdout })

  const rawParsed = parseAgentResult(raw.ok ? raw.value : execution.stdout)
  const parsed = normalizeAgentResult(rawParsed)
  const status = normalizeStatus(execution, parsed)
  const endedAt = new Date().toISOString()
  const result = {
    id: task.id,
    title: task.title,
    status,
    startedAt,
    endedAt,
    taskDir,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    parsed,
    rawParsed,
    usage: extractUsage(raw.ok ? raw.value : parsed),
  }

  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

function buildPrompt(task) {
  return `You are a Claude Code CLI subagent controlled by Codex.

Task id: ${task.id}
Task title: ${task.title}
Task kind: ${task.kind}
Workspace: ${task.workspace}

Controller rules:
- Stay within the requested task.
- Prefer small, reviewable changes.
- If you edit files, run the most relevant verification command when practical.
- Return only JSON matching the provided schema.
- Do not include markdown fences around the JSON.
- Be precise about files changed, commands run, and remaining risks.

Task:
${task.prompt}
`
}

function buildClaudeCommand(task, schema, executable) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--no-session-persistence',
    '--name',
    `subagent-${task.id}`,
    '--permission-mode',
    task.permissionMode,
  ]

  if (task.model) args.push('--model', task.model)
  if (task.effort) args.push('--effort', task.effort)
  if (typeof task.maxBudgetUsd === 'number') args.push('--max-budget-usd', String(task.maxBudgetUsd))
  if (task.systemPrompt) args.push('--append-system-prompt', task.systemPrompt)
  for (const dir of task.addDirs) args.push('--add-dir', dir)
  if (task.allowedTools.length) args.push('--allowedTools', task.allowedTools.join(','))
  if (task.disallowedTools.length) args.push('--disallowedTools', task.disallowedTools.join(','))
  if (Array.isArray(task.tools)) args.push('--tools', task.tools.join(','))

  return {
    executable,
    args,
    display: `${quoteArg(executable)} ${args.map(quoteArg).join(' ')} < prompt.md`,
  }
}

function quoteArg(value) {
  if (/^[A-Za-z0-9._:/\\=-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function spawnClaude(executable, args, prompt, cwd, timeoutMs, taskDir) {
  return new Promise((resolve) => {
    const stdinPrompt = prompt.length > 20000
      ? `Read and follow the full task prompt saved at ${path.join(taskDir, 'prompt.md')}. Return only JSON that matches the requested schema.`
      : prompt
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const stdoutPath = path.join(taskDir, 'stdout.txt')
    const stderrPath = path.join(taskDir, 'stderr.txt')

    const timeout = setTimeout(async () => {
      timedOut = true
      await killProcessTree(child.pid)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', async (error) => {
      clearTimeout(timeout)
      stderr += `${os.EOL}${error.stack || String(error)}`
      await fs.writeFile(stdoutPath, stdout, 'utf8')
      await fs.writeFile(stderrPath, stderr, 'utf8')
      resolve({ stdout, stderr, exitCode: 1, signal: null, timedOut })
    })
    child.on('close', async (exitCode, signal) => {
      clearTimeout(timeout)
      await fs.writeFile(stdoutPath, stdout, 'utf8')
      await fs.writeFile(stderrPath, stderr, 'utf8')
      resolve({ stdout, stderr, exitCode, signal, timedOut })
    })

    child.stdin.end(stdinPrompt)
  })
}

async function resolveClaudeExecutable(preferred) {
  if (preferred) {
    const value = String(preferred)
    return /[\\/:]/.test(value) ? path.resolve(value) : value
  }
  if (process.platform !== 'win32') return 'claude'

  const where = await captureProcess('where.exe', ['claude'], process.cwd(), 10000)
  const candidates = where.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith('.cmd')) {
      const exe = await resolveExeFromCmd(candidate)
      if (exe) return exe
    }
    const siblingExe = path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (await exists(siblingExe)) return siblingExe
  }

  return 'claude.cmd'
}

async function resolveExeFromCmd(cmdPath) {
  try {
    const content = await fs.readFile(cmdPath, 'utf8')
    const match = content.match(/"([^"]*claude\.exe)"/i)
    if (!match) return null
    const exePath = match[1].replace(/%dp0%\\?/i, path.dirname(cmdPath) + path.sep)
    return await exists(exePath) ? exePath : null
  } catch {
    return null
  }
}

function captureProcess(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Ignore.
      }
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({ exitCode: 1, stdout, stderr: stderr + os.EOL + String(error) })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('close', resolve)
      killer.on('error', resolve)
    })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already exited.
  }
}

function safeJsonParse(value) {
  const text = typeof value === 'string' ? value.trim() : value
  if (!text) return { ok: false, error: 'empty output' }
  if (typeof text !== 'string') return { ok: true, value: text }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function parseAgentResult(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    const parsed = safeJsonParse(raw)
    return parsed.ok ? parsed.value : null
  }
  if (raw.structured_output) return raw.structured_output
  if (raw.status && raw.summary) return raw
  if (raw.result) {
    const result = typeof raw.result === 'string' ? raw.result.trim() : raw.result
    const parsed = safeJsonParse(result)
    if (parsed.ok) return parsed.value
  }
  if (raw.message?.content) {
    const text = Array.isArray(raw.message.content)
      ? raw.message.content.map((part) => part.text || '').join('')
      : String(raw.message.content)
    const parsed = safeJsonParse(text)
    if (parsed.ok) return parsed.value
  }
  return raw
}

function normalizeAgentResult(value) {
  if (!value || typeof value !== 'object') return value

  const status = mapAgentStatus(value.status || value.result || value.outcome)
  const filesChanged = value.filesChanged || value.files_changed || value.changedFiles || value.changed_files || []
  const commandsRun = value.commandsRun || value.commands_run || value.commands || []
  const verification = value.verification || value.verifications || value.checks || []
  const risks = value.risks || value.remaining_risks || value.remainingRisks || []
  const nextSteps = value.nextSteps || value.next_steps || []

  if (status && value.summary) {
    return {
      status,
      summary: String(value.summary),
      filesChanged: normalizeFilesChanged(filesChanged),
      commandsRun: normalizeCommands(commandsRun),
      verification: normalizeVerification(verification),
      risks: normalizeRisks(risks),
      nextSteps: Array.isArray(nextSteps) ? nextSteps.map(String) : [],
      metrics: value.metrics,
    }
  }

  return value
}

function mapAgentStatus(status) {
  const text = String(status || '').toLowerCase()
  if (['completed', 'complete', 'passed', 'pass', 'success', 'succeeded', 'done', 'ok'].includes(text)) return 'completed'
  if (['partial', 'partially_completed'].includes(text)) return 'partial'
  if (['blocked', 'stuck'].includes(text)) return 'blocked'
  if (['failed', 'fail', 'error'].includes(text)) return 'failed'
  return null
}

function mapCheckStatus(status) {
  const text = String(status || '').toLowerCase()
  if (['passed', 'pass', 'success', 'succeeded', 'ok', 'completed'].includes(text)) return 'passed'
  if (['failed', 'fail', 'error'].includes(text)) return 'failed'
  if (['skipped', 'skip'].includes(text)) return 'skipped'
  if (['not_run', 'not run', 'not-run'].includes(text)) return 'not_run'
  return 'not_run'
}

function normalizeFilesChanged(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return { path: item, change: '' }
    return {
      path: String(item.path || item.file || ''),
      change: String(item.change || item.description || item.summary || ''),
    }
  })
}

function normalizeCommands(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return { command: item, status: 'not_run' }
    return {
      command: String(item.command || item.cmd || ''),
      status: mapCheckStatus(item.status),
      notes: item.notes || item.detail || item.evidence || '',
    }
  })
}

function normalizeVerification(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return { check: item, status: 'not_run' }
    return {
      check: String(item.check || item.name || item.title || ''),
      status: mapCheckStatus(item.status),
      evidence: item.evidence || item.detail || item.notes || '',
    }
  })
}

function normalizeRisks(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return { risk: item, severity: 'low' }
    return {
      risk: String(item.risk || item.description || item.summary || ''),
      severity: ['low', 'medium', 'high'].includes(item.severity) ? item.severity : 'low',
      mitigation: item.mitigation || '',
    }
  })
}

function normalizeStatus(execution, parsed) {
  if (execution.timedOut) return 'timed_out'
  if (execution.exitCode !== 0) return 'failed'
  if (!parsed || typeof parsed !== 'object') return 'partial'
  if (['completed', 'partial', 'blocked', 'failed'].includes(parsed.status)) {
    return parsed.status
  }
  return 'partial'
}

function extractUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const candidates = [
    raw.usage,
    raw.metrics,
    raw.message?.usage,
    raw.result?.usage,
  ].filter(Boolean)
  const usage = candidates.find((candidate) => typeof candidate === 'object')
  if (!usage) return null
  return usage
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + os.EOL, 'utf8')
}

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractUsage,
  normalizeAgentResult,
  normalizeStatus,
  parseAgentResult,
} from './result-normalizer.mjs'
import { safeJsonParse, writeJson } from './json.mjs'
import { captureProcess, exists, killProcessTree } from './process-tree.mjs'

const activeProcesses = new Map()

export function listActiveProcesses() {
  return [...activeProcesses.values()].map(({ runId, taskId, title, pid, startedAt }) => ({
    runId,
    taskId,
    title,
    pid,
    startedAt,
  }))
}

export async function cancelActiveRun(runId) {
  const targets = [...activeProcesses.values()].filter((record) => record.runId === runId)
  await Promise.all(targets.map((record) => killProcessTree(record.pid)))
  return { runId, cancelledProcesses: targets.length }
}

export async function runClaudeTask(task, context) {
  const taskDir = path.join(context.runDir, 'tasks', task.id)
  await fs.mkdir(taskDir, { recursive: true })

  const startedAt = new Date().toISOString()
  const prompt = buildPrompt(task)
  const command = buildClaudeCommand(task, context.schema, context.claudeExecutable, context.claudeBaseArgs)

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

  if (context.dryRun) {
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
        summary: 'Dry run only; Claude Code CLI was not invoked.',
        filesChanged: [],
        commandsRun: [],
        verification: [{ check: 'dry-run', status: 'passed', evidence: command.display }],
        risks: [],
        nextSteps: [],
      },
      command: command.display,
    }
    await writeJson(path.join(taskDir, 'result.json'), dryResult)
    return dryResult
  }

  const execution = await spawnClaude({
    executable: command.executable,
    args: command.args,
    prompt,
    cwd: task.workspace,
    timeoutMs: task.timeoutMs,
    taskDir,
    runId: context.runId,
    taskId: task.id,
    title: task.title,
    env: context.env,
  })

  const raw = safeJsonParse(execution.stdout)
  await writeJson(
    path.join(taskDir, 'raw-output.json'),
    raw.ok ? raw.value : { parseError: raw.error, stdout: execution.stdout },
  )

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
    command: command.display,
  }

  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

export async function resolveClaudeExecutable(preferred) {
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
    const siblingExe = path.join(
      path.dirname(candidate),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    )
    if (await exists(siblingExe)) return siblingExe
  }

  return 'claude.cmd'
}

export function buildPrompt(task) {
  return `You are a Claude Code CLI subagent controlled by Codex through Subagent Control Protocol.

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
- Be precise about files changed, commands run, verification evidence, risks, and next steps.

Task:
${task.prompt}
`
}

function buildClaudeCommand(task, schema, executable, claudeBaseArgs = []) {
  const args = [
    ...claudeBaseArgs,
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
  const displayArgs = [
    ...claudeBaseArgs,
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    '<agent-result.schema.json>',
    '--no-session-persistence',
    '--name',
    `subagent-${task.id}`,
    '--permission-mode',
    task.permissionMode,
  ]

  pushOptionalArg(args, displayArgs, task.model, '--model')
  pushOptionalArg(args, displayArgs, task.effort, '--effort')
  pushOptionalArg(args, displayArgs, task.maxBudgetUsd, '--max-budget-usd')
  pushOptionalArg(args, displayArgs, task.systemPrompt, '--append-system-prompt')
  for (const dir of task.addDirs) {
    args.push('--add-dir', dir)
    displayArgs.push('--add-dir', dir)
  }
  pushOptionalArg(args, displayArgs, task.allowedTools.length ? task.allowedTools.join(',') : null, '--allowedTools')
  pushOptionalArg(args, displayArgs, task.disallowedTools.length ? task.disallowedTools.join(',') : null, '--disallowedTools')
  if (Array.isArray(task.tools)) {
    args.push('--tools', task.tools.join(','))
    displayArgs.push('--tools', task.tools.join(','))
  }

  return {
    executable,
    args,
    display: `${quoteArg(executable)} ${displayArgs.map(quoteArg).join(' ')} < prompt.md`,
  }
}

function pushOptionalArg(args, displayArgs, value, flag) {
  if (value === undefined || value === null || value === '') return
  args.push(flag, String(value))
  displayArgs.push(flag, String(value))
}

function spawnClaude(options) {
  return new Promise((resolve) => {
    const stdinPrompt = options.prompt.length > 20000
      ? `Read and follow the full task prompt saved at ${path.join(options.taskDir, 'prompt.md')}. Return only JSON that matches the requested schema.`
      : options.prompt

    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const stdoutPath = path.join(options.taskDir, 'stdout.txt')
    const stderrPath = path.join(options.taskDir, 'stderr.txt')
    const activeKey = `${options.runId}:${options.taskId}`

    activeProcesses.set(activeKey, {
      runId: options.runId,
      taskId: options.taskId,
      title: options.title,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    })

    const timeout = setTimeout(async () => {
      timedOut = true
      await killProcessTree(child.pid)
    }, options.timeoutMs)

    const finish = async ({ exitCode, signal }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      activeProcesses.delete(activeKey)
      await fs.writeFile(stdoutPath, stdout, 'utf8')
      await fs.writeFile(stderrPath, stderr, 'utf8')
      resolve({ stdout, stderr, exitCode, signal, timedOut })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', async (error) => {
      stderr += `${os.EOL}${error.stack || String(error)}`
      await finish({ exitCode: 1, signal: null })
    })
    child.on('close', async (exitCode, signal) => {
      await finish({ exitCode, signal })
    })

    child.stdin.end(stdinPrompt)
  })
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

function quoteArg(value) {
  if (/^[A-Za-z0-9._:/\\=-]+$/.test(value)) return value
  return JSON.stringify(value)
}

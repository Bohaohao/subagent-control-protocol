import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractUsage,
  normalizeAgentResult,
  normalizeStatus,
  parseAgentResult,
  summarizeUsage,
} from './result-normalizer.mjs'
import { safeJsonParse, writeJson } from './json.mjs'
import { captureProcess, exists, killProcessTree } from './process-tree.mjs'

const activeProcesses = new Map()

export function listActiveProcesses(runId) {
  const records = runId
    ? [...activeProcesses.values()].filter((record) => record.runId === runId)
    : [...activeProcesses.values()]
  return records.map(({ runId, taskId, title, pid, startedAt }) => ({
    runId,
    taskId,
    title,
    pid,
    startedAt,
  }))
}

export async function cancelActiveRun(runId) {
  const targets = [...activeProcesses.values()].filter((record) => record.runId === runId)
  targets.forEach((record) => {
    record.cancelled = true
  })
  await Promise.all(targets.map((record) => killProcessTree(record.pid)))
  return { runId, cancelledProcesses: targets.length }
}

export async function runClaudeTask(task, context) {
  const taskDir = path.join(context.runDir, 'tasks', task.id)
  await fs.mkdir(taskDir, { recursive: true })

  const startedAt = new Date().toISOString()
  const prompt = buildPrompt(task)
  const command = buildClaudeCommand(
    task,
    context.schema,
    context.claudeExecutable,
    context.claudeBaseArgs,
    [taskDir],
  )

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
      cancelled: false,
      parsed: {
        status: 'completed',
        summary: 'Dry run only; Claude Code CLI was not invoked.',
        filesChanged: [],
        commandsRun: [],
        verification: [{ check: 'dry-run', status: 'passed', evidence: command.display }],
        risks: [],
        nextSteps: [],
        tokenUsageSummary: 'Dry run; Claude Code CLI was not invoked, so exact token usage was not visible to a Claude subagent.',
        metrics: {},
      },
      usage: null,
      measuredUsageSummary: 'Dry run; no token usage was measured.',
      command: command.display,
    }
    await writeJson(path.join(taskDir, 'result.json'), dryResult)
    return dryResult
  }

  const execution = await spawnClaude({
    executable: command.executable,
    args: command.args,
    shell: command.shell,
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
  const rawValue = raw.ok ? raw.value : null
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
    cancelled: Boolean(execution.cancelled),
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    parsed,
    rawParsed,
    usage: extractUsage(rawValue || parsed),
    measuredUsageSummary: summarizeUsage(rawValue || parsed),
    command: command.display,
  }

  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

export async function resolveClaudeExecutable(preferred) {
  if (preferred) {
    const value = String(preferred)
    if (process.platform === 'win32' && !/[\\/:]/.test(value)) {
      const target = await resolveWindowsCommand(value)
      if (target) return target
    }
    const resolved = /[\\/:]/.test(value) ? path.resolve(value) : value
    // An explicit .cmd override still needs to be unpacked into its underlying
    // node/exe target so we can spawn it without a shell.
    if (/\.cmd$/i.test(resolved) && /[\\/:]/.test(resolved)) {
      const target = await resolveTargetFromCmd(resolved)
      if (target) return { ...target, shell: false }
    }
    return { executable: resolved, preArgs: [], shell: false }
  }

  if (process.platform !== 'win32') return { executable: 'claude', preArgs: [], shell: false }

  return await resolveWindowsCommand('claude')
    || { executable: 'claude.cmd', preArgs: [], shell: true }
}

async function resolveWindowsCommand(commandName) {
  const where = await captureProcess('where.exe', [commandName], process.cwd(), 10000)
  const candidates = where.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    if (lower.endsWith('.cmd')) {
      const target = await resolveTargetFromCmd(candidate)
      if (target) return { ...target, shell: false }
      continue
    }
    if (lower.endsWith('.exe')) {
      if (await exists(candidate)) return { executable: candidate, preArgs: [], shell: false }
      continue
    }
    const siblingExe = path.join(
      path.dirname(candidate),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    )
    if (await exists(siblingExe)) return { executable: siblingExe, preArgs: [], shell: false }
  }

  // Last resort: drive a .cmd wrapper through cmd.exe. Arg quoting for the
  // JSON schema is fragile here, so this only triggers when unpacking failed.
  const cmdCandidate = candidates.find((candidate) => candidate.toLowerCase().endsWith('.cmd'))
  if (cmdCandidate) {
    return { executable: 'cmd.exe', preArgs: ['/c', cmdCandidate], shell: false }
  }
  return null
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
- Always include tokenUsageSummary as a string. If exact token counts are not visible to you while composing the result, say that clearly and do not invent exact counts.

Task:
${task.prompt}
`
}

function buildClaudeCommand(task, schema, claudeResolved, claudeBaseArgs = [], extraDirs = []) {
  const { executable, preArgs = [], shell = false } = claudeResolved || {}
  const args = [
    ...preArgs,
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
    ...preArgs,
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
  // Always expose the task's own artifact dir so a large prompt saved to
  // prompt.md (outside the workspace) stays readable by the subagent.
  const allDirs = [...new Set([...task.addDirs, ...extraDirs].filter(Boolean))]
  for (const dir of allDirs) {
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
    shell,
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
      shell: options.shell ?? false,
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

    const record = {
      runId: options.runId,
      taskId: options.taskId,
      title: options.title,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      cancelled: false,
    }
    activeProcesses.set(activeKey, record)

    const finish = async ({ exitCode, signal }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killGraceTimeout)
      activeProcesses.delete(activeKey)
      await fs.writeFile(stdoutPath, stdout, 'utf8')
      await fs.writeFile(stderrPath, stderr, 'utf8')
      resolve({ stdout, stderr, exitCode, signal, timedOut, cancelled: Boolean(record.cancelled) })
    }

    let killGraceTimeout = null
    const timeout = setTimeout(async () => {
      timedOut = true
      await killProcessTree(child.pid)
      killGraceTimeout = setTimeout(async () => {
        await finish({ exitCode: 1, signal: 'timeout_grace_expired' })
      }, 10000)
    }, options.timeoutMs)

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

    child.stdin.on('error', () => {
      // The child may exit before reading the whole prompt; close/error events
      // still settle the task and persist stderr/stdout.
    })
    child.stdin.end(stdinPrompt)
  })
}

async function resolveTargetFromCmd(cmdPath) {
  try {
    const content = await fs.readFile(cmdPath, 'utf8')
    const dir = path.dirname(cmdPath)
    const expand = (value) =>
      value
        .replace(/%~dp0\\?/gi, dir + path.sep)
        .replace(/%dp0%\\?/gi, dir + path.sep)

    // npm-generated .cmd shims invoke `node "...\cli.js" %*`. Prefer unpacking
    // to the node binary + script so we can spawn without a shell (which would
    // mangle the --json-schema argument quoting on Windows).
    const scriptMatch = content.match(/"([^"]*\.(?:js|cjs|mjs))"/i)
    if (scriptMatch) {
      const scriptPath = expand(scriptMatch[1])
      if (await exists(scriptPath)) {
        const nodeMatch = content.match(/"([^"]*node(?:\.exe)?)"/i)
        const nodeBin = nodeMatch ? expand(nodeMatch[1]) : process.execPath
        const executable = (await exists(nodeBin)) ? nodeBin : process.execPath
        return { executable, preArgs: [scriptPath] }
      }
    }

    const exeMatch = content.match(/"([^"]*claude\.exe)"/i)
    if (exeMatch) {
      const exePath = expand(exeMatch[1])
      if (await exists(exePath)) return { executable: exePath, preArgs: [] }
    }

    return null
  } catch {
    return null
  }
}

function quoteArg(value) {
  if (/^[A-Za-z0-9._:/\\=-]+$/.test(value)) return value
  return JSON.stringify(value)
}

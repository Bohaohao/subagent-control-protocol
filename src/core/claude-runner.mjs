import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { statSync } from 'node:fs'
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
const RUNTIME_HEARTBEAT_MS = 45_000

export function listActiveProcesses(runId) {
  const records = runId
    ? [...activeProcesses.values()].filter((record) => record.runId === runId)
    : [...activeProcesses.values()]
  return records.map(({ runId, taskId, title, pid, startedAt, eventLogPath }) => {
    const record = {
      runId,
      taskId,
      title,
      pid,
      startedAt,
      eventLogPath,
    }
    // Derive last activity cheaply from the event log's mtime; never read the
    // (potentially large) log contents in this hot path.
    if (eventLogPath) {
      try {
        record.lastEventAt = statSync(eventLogPath).mtime.toISOString()
      } catch {
        // Event log may not exist yet (spawn not finished); skip silently.
      }
    }
    return record
  })
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

  const eventLogPath = path.join(taskDir, 'events.jsonl')
  const startedAt = new Date().toISOString()
  const prompt = buildPrompt(task)
  const command = buildClaudeCommand(
    task,
    context.schema,
    context.claudeExecutable,
    context.claudeBaseArgs,
    [taskDir],
  )

  await appendEvent(eventLogPath, {
    type: 'task_started',
    runId: context.runId,
    taskId: task.id,
    title: task.title,
    kind: task.kind,
    dryRun: Boolean(context.dryRun),
    command: command.display,
  })

  await fs.writeFile(path.join(taskDir, 'prompt.md'), prompt, 'utf8')
  await writeJson(path.join(taskDir, 'task.json'), {
    id: task.id,
    title: task.title,
    kind: task.kind,
    dependsOn: task.dependsOn,
    command: command.display,
    timeoutMs: task.timeoutMs,
    cwd: task.workspace,
    eventLogPath,
  })

  if (context.dryRun) {
    const endedAt = new Date().toISOString()
    const dryResult = {
      id: task.id,
      title: task.title,
      status: 'completed',
      startedAt,
      endedAt,
      taskDir,
      eventLogPath,
      lastEventAt: lastEventTimestamp(eventLogPath),
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
    await appendEvent(eventLogPath, {
      type: 'task_completed',
      runId: context.runId,
      taskId: task.id,
      status: 'completed',
      exitCode: 0,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    })
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
    eventLogPath,
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
    eventLogPath,
    lastEventAt: lastEventTimestamp(eventLogPath),
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
  await appendEvent(eventLogPath, {
    type: terminalEventType(status),
    runId: context.runId,
    taskId: task.id,
    status,
    exitCode: execution.exitCode,
    timedOut: Boolean(execution.timedOut),
    cancelled: Boolean(execution.cancelled),
    durationMs: result.durationMs,
  })
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

Task event logging:
- The environment exposes SCP_EVENT_LOG (path to a JSONL file), SCP_RUN_ID, SCP_TASK_ID, and SCP_TASK_DIR.
- As you work, append one compact JSON object per line to the file at SCP_EVENT_LOG to report progress. Each line must be valid JSON on its own.
- Every event must carry a short \`type\` and an ISO \`timestamp\`. Reuse SCP_RUN_ID as \`runId\` and SCP_TASK_ID as \`taskId\` so events can be correlated back to this task. Beyond that, keep each event type's payload compact - a label or one-line summary is enough. Never include full logs, diffs, file contents, or code in events.
- Emit events for these runtime milestones, each with the fields noted:
  - phase_started: \`type\`, \`timestamp\`, \`phase\` (short name of the phase you are beginning).
  - heartbeat: \`type\`, \`timestamp\`, \`runId\`, \`taskId\`, \`summary\` (one line on current progress), \`sequence\` (an integer that increments with every heartbeat so ordering is visible).
  - checkpoint: \`type\`, \`timestamp\`, \`summary\` (one line on the unit of progress just completed).
  - blocked: \`type\`, \`timestamp\`, \`reason\` (one line on what you are waiting on).
  - command_started: \`type\`, \`timestamp\`, \`label\` (short name of the verification/shell command), \`command\` (one-line form, no full output).
  - command_finished: \`type\`, \`timestamp\`, \`label\`, \`exitCode\`, \`status\` ('pass' | 'fail').
- Send a heartbeat at least every 45 seconds during long work, incrementing \`sequence\` each time.
- Event logging is best-effort and must never replace the required JSON result; if writing to SCP_EVENT_LOG fails, continue the task and still return the JSON result.

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
      env: {
        ...process.env,
        ...(options.env || {}),
        SCP_EVENT_LOG: options.eventLogPath,
        SCP_RUN_ID: options.runId,
        SCP_TASK_ID: options.taskId,
        SCP_TASK_DIR: options.taskDir,
      },
      shell: options.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let heartbeatSequence = 0
    let lastActivityAt = new Date().toISOString()
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
      eventLogPath: options.eventLogPath,
    }
    activeProcesses.set(activeKey, record)

    // process_started is runtime-owned; pid is known once spawn returns.
    appendEvent(options.eventLogPath, {
      type: 'process_started',
      runId: options.runId,
      taskId: options.taskId,
      pid: child.pid,
    }).catch(() => {
      // best-effort: never break the run over event logging
    })

    const heartbeat = setInterval(() => {
      appendEvent(options.eventLogPath, {
        type: 'heartbeat',
        runId: options.runId,
        taskId: options.taskId,
        sequence: ++heartbeatSequence,
        source: 'runtime',
        summary: 'runtime heartbeat: Claude process is still active',
        lastActivityAt,
      }).catch(() => {})
    }, RUNTIME_HEARTBEAT_MS)
    heartbeat.unref?.()

    const finish = async ({ exitCode, signal }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killGraceTimeout)
      clearInterval(heartbeat)
      activeProcesses.delete(activeKey)
      await fs.writeFile(stdoutPath, stdout, 'utf8')
      await fs.writeFile(stderrPath, stderr, 'utf8')
      await appendEvent(options.eventLogPath, {
        type: 'process_exited',
        runId: options.runId,
        taskId: options.taskId,
        pid: child.pid,
        exitCode,
        signal: signal || null,
        timedOut,
        cancelled: Boolean(record.cancelled),
      })
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
      lastActivityAt = new Date().toISOString()
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      lastActivityAt = new Date().toISOString()
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

function terminalEventType(status) {
  if (status === 'completed') return 'task_completed'
  if (status === 'partial') return 'task_partial'
  if (status === 'blocked') return 'task_blocked'
  if (status === 'timed_out') return 'task_timed_out'
  if (status === 'cancelled') return 'task_cancelled'
  return 'task_failed'
}

// Derive the timestamp of the most recently appended event cheaply from the
// event log's mtime; never read the (potentially large) log contents. Returns
// null when the log does not exist (e.g. spawn never finished) or cannot be
// stated. Best-effort: callers treat a null as "no event observed yet".
function lastEventTimestamp(eventLogPath) {
  if (!eventLogPath) return null
  try {
    return statSync(eventLogPath).mtime.toISOString()
  } catch {
    return null
  }
}

// Append one compact JSON object as a line to the per-task event log. Best
// effort: event logging must never break a run, so failures are swallowed.
async function appendEvent(eventLogPath, event) {
  if (!eventLogPath) return
  try {
    const timestamp = event?.timestamp || event?.ts || new Date().toISOString()
    const normalized = { ...event, timestamp }
    delete normalized.ts
    const line = JSON.stringify(normalized)
    await fs.appendFile(eventLogPath, `${line}\n`, 'utf8')
  } catch {
    // ignore - event logging is best-effort
  }
}

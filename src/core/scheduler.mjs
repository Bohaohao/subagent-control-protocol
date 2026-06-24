import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cancelActiveRun, listActiveProcesses, resolveClaudeExecutable, runClaudeTask } from './claude-runner.mjs'
import { createRunId, readJson, writeJson } from './json.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const resultSchemaPath = path.join(packageRoot, 'schemas', 'agent-result.schema.json')

// runId -> { cancelled: boolean }. Lets cancelRun() stop pending tasks, not just
// kill the currently-running Claude processes.
const activeRuns = new Map()

export async function runTaskPlan(plan, options = {}) {
  assertPlanShape(plan)

  const planDir = path.resolve(options.planDir || process.cwd())
  const workspace = path.resolve(planDir, String(options.workspace || plan.workspace || '.'))
  const outputDir = path.resolve(
    planDir,
    String(options.outputDir || plan.outputDir || path.join(workspace, '.subagent-runs')),
  )
  const concurrency = Number(options.concurrency || plan.concurrency || 1)
  const dryRun = Boolean(options.dryRun || plan.dryRun)

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer')
  }

  const runId = options.runId || createRunId()
  const runDir = path.join(outputDir, runId)
  const schema = options.schema || await readJson(resultSchemaPath)
  const claudeExecutable = await resolveClaudeExecutable(
    options.claudeExecutable || process.env.CLAUDE_BIN || process.env.CLAUDE_CODE_COMMAND,
  )
  const claudeBaseArgs = options.claudeBaseArgs || firstNonEmptyArray(
    parseJsonArrayEnv('SUBAGENT_CLAUDE_BASE_ARGS'),
    parseJsonArrayEnv('CLAUDE_CODE_BASE_ARGS'),
  )
  const tasks = plan.tasks.map((task) => normalizeTask(task, plan.defaults || {}, workspace, planDir))
  validateDependencies(tasks)

  await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true })
  await writeJson(path.join(runDir, 'run-input.json'), {
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

  const scheduler = {
    runId,
    runDir,
    workspace,
    concurrency,
    dryRun,
    schema,
    claudeExecutable,
    claudeBaseArgs,
    env: options.env,
    startedAt: new Date().toISOString(),
    maxParallelObserved: 0,
    cancellation: { cancelled: false },
  }

  activeRuns.set(runId, scheduler.cancellation)
  try {
    const results = await runTasks(tasks, scheduler)
    const endedAt = new Date().toISOString()
    const summary = summarizeRun({ ...scheduler, endedAt }, tasks, results)
    await writeJson(path.join(runDir, 'run-summary.json'), summary)
    return summary
  } finally {
    activeRuns.delete(runId)
  }
}

export async function loadRunStatus({ runDir, outputDir, limit = 20 } = {}) {
  if (runDir) {
    const resolved = path.resolve(runDir)
    const summaryPath = path.join(resolved, 'run-summary.json')
    const summary = await readJson(summaryPath)
    // Report only this run's active processes, not every run the server knows about.
    const runId = summary?.runId || path.basename(resolved)
    return { mode: 'single', summary, active: listActiveProcesses(runId) }
  }

  const baseDir = path.resolve(outputDir || path.join(process.cwd(), '.subagent-runs'))
  let entries = []
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true })
  } catch {
    return { mode: 'list', outputDir: baseDir, runs: [], active: listActiveProcesses() }
  }

  const runDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name))
    .sort()
    .reverse()
    .slice(0, limit)

  const runs = []
  for (const dir of runDirs) {
    try {
      runs.push(await readJson(path.join(dir, 'run-summary.json')))
    } catch {
      runs.push({ runDir: dir, status: 'incomplete_or_unreadable' })
    }
  }

  return { mode: 'list', outputDir: baseDir, runs, active: listActiveProcesses() }
}

export async function cancelRun(runId) {
  // Signal the scheduler loop to stop starting pending tasks, then kill the
  // Claude processes that are already running for this run.
  const cancellation = activeRuns.get(runId)
  if (cancellation) cancellation.cancelled = true
  return cancelActiveRun(runId)
}

export function assertPlanShape(plan) {
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

  const timeoutMs = Number(merged.timeoutMs || 600000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`Task ${task.id} has invalid timeoutMs: ${merged.timeoutMs} (must be an integer >= 1000)`)
  }

  // Read-only safety for review/verify work: when the caller has not customized
  // tool restrictions, block the mutating file-edit tools so a review can't
  // rewrite the repo it is inspecting. Explicit allowedTools/disallowedTools opt out.
  const readOnlyKind = task.kind === 'review' || task.kind === 'verify'
  const callerRestrictedTools = Boolean(
    (task.allowedTools && task.allowedTools.length) || (task.disallowedTools && task.disallowedTools.length),
  )
  const disallowedTools = [...(merged.disallowedTools || [])]
  if (readOnlyKind && !callerRestrictedTools) {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      if (!disallowedTools.includes(tool)) disallowedTools.push(tool)
    }
  }

  return {
    id: task.id,
    title: task.title,
    kind: task.kind || 'other',
    prompt: task.prompt,
    dependsOn: task.dependsOn || [],
    model: merged.model,
    effort: merged.effort,
    timeoutMs,
    permissionMode: merged.permissionMode || 'default',
    addDirs,
    allowedTools: merged.allowedTools || [],
    disallowedTools,
    tools: merged.tools,
    systemPrompt: merged.systemPrompt || '',
    workspace,
  }
}

function validateDependencies(tasks) {
  const ids = new Set()
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`)
    }
    ids.add(task.id)
  }
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
    // If the run was cancelled, stop starting new tasks: mark everything still
    // pending as cancelled and let the already-running (and being-killed) tasks
    // drain through the normal completion path below.
    if (scheduler.cancellation.cancelled && pending.size) {
      for (const [taskId, task] of pending) {
        const cancelled = await writeCancelledTask(task, scheduler)
        finished.set(taskId, cancelled)
        results.push(cancelled)
      }
      pending.clear()
    }

    let startedAny = false

    for (const [taskId, task] of pending) {
      if (running.size >= scheduler.concurrency) break

      const depResults = task.dependsOn.map((depId) => finished.get(depId)).filter(Boolean)
      if (depResults.length !== task.dependsOn.length) continue

      const failedDep = depResults.find((result) => !['completed', 'partial'].includes(result.status))
      if (failedDep) {
        const skipped = await writeSkippedTask(task, scheduler, failedDep)
        pending.delete(taskId)
        finished.set(taskId, skipped)
        results.push(skipped)
        startedAny = true
        continue
      }

      pending.delete(taskId)
      const promise = runClaudeTask(task, scheduler).catch((error) => writeFailedTask(task, scheduler, error))
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
        promise.then((result) => ({ taskId, result })),
      ),
    )
    running.delete(completed.taskId)
    finished.set(completed.taskId, completed.result)
    results.push(completed.result)
  }

  return results.sort((a, b) => tasks.findIndex((task) => task.id === a.id) - tasks.findIndex((task) => task.id === b.id))
}

async function writeSkippedTask(task, scheduler, failedDep) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  const now = new Date().toISOString()
  const result = {
    id: task.id,
    title: task.title,
    status: 'skipped',
    startedAt: now,
    endedAt: now,
    taskDir,
    reason: `Dependency ${failedDep.id} ended with status ${failedDep.status}`,
  }
  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

async function writeCancelledTask(task, scheduler) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  const now = new Date().toISOString()
  const result = {
    id: task.id,
    title: task.title,
    status: 'cancelled',
    startedAt: now,
    endedAt: now,
    taskDir,
    reason: 'Run cancelled before this task started',
  }
  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

async function writeFailedTask(task, scheduler, error) {
  const taskDir = path.join(scheduler.runDir, 'tasks', task.id)
  const now = new Date().toISOString()
  const result = {
    id: task.id,
    title: task.title,
    status: 'failed',
    startedAt: now,
    endedAt: now,
    taskDir,
    error: error?.stack || String(error),
  }
  await writeJson(path.join(taskDir, 'result.json'), result)
  return result
}

function summarizeRun(scheduler, tasks, results) {
  return {
    runId: scheduler.runId,
    runDir: scheduler.runDir,
    startedAt: scheduler.startedAt,
    endedAt: scheduler.endedAt,
    workspace: scheduler.workspace,
    concurrency: scheduler.concurrency,
    maxParallelObserved: scheduler.maxParallelObserved,
    dryRun: scheduler.dryRun,
    totalTasks: tasks.length,
    completedTasks: results.filter((result) => result.status === 'completed').length,
    partialTasks: results.filter((result) => result.status === 'partial').length,
    blockedTasks: results.filter((result) => result.status === 'blocked').length,
    failedTasks: results.filter((result) => result.status === 'failed').length,
    skippedTasks: results.filter((result) => result.status === 'skipped').length,
    cancelledTasks: results.filter((result) => result.status === 'cancelled').length,
    timedOutTasks: results.filter((result) => result.status === 'timed_out').length,
    tasks: results,
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function parseJsonArrayEnv(name) {
  const raw = process.env[name]
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function firstNonEmptyArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length > 0) || []
}

import { safeJsonParse } from './json.mjs'
import { repairAgentResultCandidate } from './result-repair.mjs'

export function parseAgentResult(raw) {
  if (!raw) return null

  if (typeof raw === 'string') {
    const parsed = safeJsonParse(raw)
    if (parsed.ok) return parseAgentResult(parsed.value)
    const repaired = repairAgentResultCandidate(raw)
    return repaired.candidate ? attachRepairDiagnostics(repaired.candidate, repaired) : null
  }

  if (raw.structured_output) return parseAgentResult(raw.structured_output)
  if (raw.status && raw.summary) return raw

  if (raw.result) {
    const result = typeof raw.result === 'string' ? raw.result.trim() : raw.result
    const parsed = safeJsonParse(result)
    if (parsed.ok) return parsed.value
    const repaired = repairAgentResultCandidate(raw)
    if (repaired.candidate) return attachRepairDiagnostics(repaired.candidate, repaired)
  }

  if (raw.message?.content) {
    const text = Array.isArray(raw.message.content)
      ? raw.message.content.map((part) => part.text || '').join('')
      : String(raw.message.content)
    const parsed = safeJsonParse(text)
    if (parsed.ok) return parsed.value
    const repaired = repairAgentResultCandidate(raw)
    if (repaired.candidate) return attachRepairDiagnostics(repaired.candidate, repaired)
  }

  const repaired = repairAgentResultCandidate(raw)
  if (repaired.candidate) return attachRepairDiagnostics(repaired.candidate, repaired)

  return raw
}

export function normalizeAgentResult(value) {
  if (!value || typeof value !== 'object') {
    const repaired = repairAgentResultCandidate(value)
    return repaired.candidate
      ? normalizeAgentResult(attachRepairDiagnostics(repaired.candidate, repaired))
      : createFallbackResult(value)
  }

  const filesChanged = value.filesChanged || value.files_changed || value.changedFiles || value.changed_files || []
  const commandsRun = value.commandsRun || value.commands_run || value.commands || []
  const normalizedCommands = normalizeCommands(commandsRun)
  const verification = normalizeVerification(value.verification || value.verifications || value.checks || [])
  const risks = value.risks || value.remaining_risks || value.remainingRisks || []
  const nextSteps = value.nextSteps || value.next_steps || []
  const status = mapAgentStatus(value.status || value.result || value.outcome)
  const summary = value.summary || value.text || value.message || value.result
  const failedCheck = [...normalizedCommands, ...verification].some((item) => item.status === 'failed')
  const normalizedStatus = status === 'completed' && failedCheck ? 'failed' : status

  if (normalizedStatus && summary) {
    return {
      status: normalizedStatus,
      summary: String(summary),
      filesChanged: normalizeFilesChanged(filesChanged),
      commandsRun: normalizedCommands,
      verification,
      risks: normalizeRisks(risks),
      nextSteps: Array.isArray(nextSteps) ? nextSteps.map(String) : [],
      tokenUsageSummary: normalizeTokenUsageSummary(value.tokenUsageSummary),
      metrics: normalizeMetrics(value.metrics),
      ...normalizeWorkerIdentity(value),
      ...(value.repair ? { repair: value.repair } : {}),
    }
  }

  return createFallbackResult(value)
}

function attachRepairDiagnostics(candidate, repair) {
  if (!candidate || typeof candidate !== 'object') return candidate
  if (!repair?.repaired) return candidate
  return {
    ...candidate,
    repair: {
      repaired: true,
      repairs: repair.repairs || [],
      errors: repair.errors || [],
    },
  }
}

export function normalizeStatus(execution, parsed) {
  if (execution.cancelled) return 'cancelled'
  if (execution.timedOut) return 'timed_out'
  if (execution.exitCode !== 0) return 'failed'
  if (!parsed || typeof parsed !== 'object') return 'partial'
  if (['completed', 'partial', 'blocked', 'failed'].includes(parsed.status)) return parsed.status
  return 'partial'
}

export function extractUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const candidates = [
    raw.usage,
    raw.metrics,
    raw.message?.usage,
    raw.result?.usage,
  ].filter(Boolean)
  return candidates.find((candidate) => typeof candidate === 'object') || null
}

export function summarizeUsage(raw) {
  const usage = extractUsage(raw)
  if (!usage || typeof usage !== 'object') {
    return 'Measured token usage was not available in the Claude CLI output.'
  }

  const input = pickNumber(usage, ['input_tokens', 'inputTokens', 'tokensInput'])
  const output = pickNumber(usage, ['output_tokens', 'outputTokens', 'tokensOutput'])
  const cacheRead = pickNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens'])
  const cacheCreate = pickNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens'])
  const cost = pickNumber(usage, ['cost_usd', 'costUsd']) ?? pickNumber(raw, ['total_cost_usd', 'totalCostUsd'])
  const parts = []

  if (typeof input === 'number') parts.push(`${input} input`)
  if (typeof output === 'number') parts.push(`${output} output`)
  if (typeof cacheRead === 'number') parts.push(`${cacheRead} cache-read`)
  if (typeof cacheCreate === 'number') parts.push(`${cacheCreate} cache-create`)
  if (!parts.length && typeof cost !== 'number') {
    return 'A usage object was present, but it did not include token counts.'
  }

  const tokenText = parts.length ? `${parts.join(', ')} tokens` : 'no token counts'
  return typeof cost === 'number'
    ? `Measured usage: ${tokenText}; estimated cost $${cost.toFixed(6)}.`
    : `Measured usage: ${tokenText}.`
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
  return value
    .map((item) => {
      if (typeof item === 'string') return { path: item, change: '' }
      return {
        path: String(item.path || item.file || ''),
        change: String(item.change || item.description || item.summary || ''),
      }
    })
    .filter((item) => item.path)
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

function normalizeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function normalizeWorkerIdentity(value) {
  if (!value || typeof value !== 'object') return {}
  const result = {}
  if (['claude', 'codex'].includes(value.workerRuntime)) result.workerRuntime = value.workerRuntime
  for (const key of ['workerType', 'workerAlias', 'plainTextResult']) {
    if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim()
  }
  for (const key of ['fallbackApplied', 'normalizationFailed']) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  return result
}

function normalizeTokenUsageSummary(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    for (const key of ['summary', 'note', 'text', 'message']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
    return JSON.stringify(value)
  }
  return 'Exact token usage was not visible to the Claude subagent while it was composing this result.'
}

function createFallbackResult(value) {
  const rendered = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? null)
  return {
    status: 'partial',
    summary: rendered && rendered !== 'null'
      ? `Claude output did not match the expected result contract: ${rendered.slice(0, 500)}`
      : 'Claude output did not match the expected result contract.',
    filesChanged: [],
    commandsRun: [],
    verification: [{ check: 'agent-result-schema', status: 'failed', evidence: 'Output was normalized from a non-conforming shape.' }],
    risks: [{ risk: 'Subagent result shape was not trustworthy without normalization.', severity: 'medium' }],
    nextSteps: [],
    tokenUsageSummary: 'Exact token usage was not visible to the Claude subagent while it was composing this result.',
    metrics: {},
  }
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const key of keys) {
    if (typeof obj[key] === 'number' && Number.isFinite(obj[key])) return obj[key]
  }
  return undefined
}

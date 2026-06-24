import { safeJsonParse } from './json.mjs'

export function parseAgentResult(raw) {
  if (!raw) return null

  if (typeof raw === 'string') {
    const parsed = safeJsonParse(raw)
    return parsed.ok ? parseAgentResult(parsed.value) : null
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

export function normalizeAgentResult(value) {
  if (!value || typeof value !== 'object') return value

  const status = mapAgentStatus(value.status || value.result || value.outcome)
  const summary = value.summary || value.text || value.message || value.result
  const filesChanged = value.filesChanged || value.files_changed || value.changedFiles || value.changed_files || []
  const commandsRun = value.commandsRun || value.commands_run || value.commands || []
  const verification = value.verification || value.verifications || value.checks || []
  const risks = value.risks || value.remaining_risks || value.remainingRisks || []
  const nextSteps = value.nextSteps || value.next_steps || []

  if (status && summary) {
    return {
      status,
      summary: String(summary),
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

export function normalizeStatus(execution, parsed) {
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

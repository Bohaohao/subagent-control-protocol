// src/core/result-repair.mjs
//
// Standalone result repair: extract a valid agent-result object from common
// Claude CLI output shapes and normalize it into the agent-result contract
// (see schemas/agent-result.schema.json).
//
// Supported input shapes:
//   - A direct agent-result object.
//   - The Claude CLI envelope { type: "result", result: "<json string>" }.
//   - A raw string containing a fenced ```json block.
//   - A raw string containing a JSON object with surrounding prose.
//   - Objects with partially mismatched keys (e.g. verificationEvidence,
//     files_changed, commands_run, next_steps).
//
// Design rules:
//   - No external dependencies; no imports from sibling modules so this stays
//     a self-contained repair surface.
//   - Never throws for malformed input; returns a failed diagnostic with
//     candidate null instead.
//   - Never fabricates exact token counts. Qualitative tokenUsageSummary is
//     preserved; otherwise a "not visible" placeholder is used.

const STATUS_ENUM = ['completed', 'partial', 'blocked', 'failed']
const CHECK_STATUS_ENUM = ['passed', 'failed', 'skipped', 'not_run']
const SEVERITY_ENUM = ['low', 'medium', 'high']

const TOKEN_NOT_VISIBLE =
  'Exact token usage was not visible to the Claude subagent while it was composing this result.'

const FALLBACK_SUMMARY =
  'Claude output was repaired into the agent-result contract; no summary was provided.'

// Maps each contract field to the source keys we accept for it, in priority
// order. The first key present on the source object wins.
const ALIASES = {
  status: ['status', 'outcome', 'result_status'],
  summary: ['summary', 'text', 'message', 'description', 'result'],
  filesChanged: ['filesChanged', 'files_changed', 'changedFiles', 'changed_files', 'files'],
  commandsRun: ['commandsRun', 'commands_run', 'commands', 'commandsExecuted'],
  verification: ['verification', 'verifications', 'checks', 'verificationsRun'],
  risks: ['risks', 'remaining_risks', 'remainingRisks', 'risk'],
  nextSteps: ['nextSteps', 'next_steps', 'followups', 'follow_ups'],
  tokenUsageSummary: ['tokenUsageSummary', 'token_usage_summary', 'tokenUsage', 'usageSummary'],
}

/**
 * Repair a Claude output value into an agent-result candidate.
 *
 * @param {unknown} value  - Raw Claude output (object, envelope, or string).
 * @param {object} [schema] - Optional JSON schema; only `required` is consulted
 *   to record residual missing-field errors after repair.
 * @returns {{repaired: boolean, failed: boolean, repairs: string[], errors: string[], candidate: object|null}}
 */
export function repairAgentResultCandidate(value, schema) {
  const repairs = []
  const errors = []
  try {
    const extracted = extractCandidate(value, repairs, errors)
    if (!extracted.ok) {
      return { repaired: false, failed: true, repairs, errors, candidate: null }
    }

    const candidate = normalizeCandidate(extracted.value, repairs, errors)
    if (!candidate) {
      return { repaired: false, failed: true, repairs, errors, candidate: null }
    }

    if (schema && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in candidate) || candidate[key] === undefined) {
          errors.push(`Missing required field after repair: ${key}`)
        }
      }
    }

    return { repaired: repairs.length > 0, failed: false, repairs, errors, candidate }
  } catch (error) {
    errors.push(`Unexpected repair failure: ${error && error.message ? error.message : String(error)}`)
    return { repaired: false, failed: true, repairs, errors, candidate: null }
  }
}

/**
 * Extract a plain object from any supported input shape. Returns
 * { ok: true, value } on success or { ok: false } when no object can be
 * recovered. Mutates `repairs`/`errors` to describe what happened.
 */
function extractCandidate(value, repairs, errors) {
  if (value === null || value === undefined) {
    errors.push('Input was null or undefined.')
    return { ok: false }
  }

  let obj
  if (typeof value === 'string') {
    obj = extractFromString(value, repairs, errors)
    if (obj === undefined) return { ok: false }
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    obj = value
  } else {
    errors.push(`Unsupported input type: ${typeof value}`)
    return { ok: false }
  }

  obj = unwrapEnvelope(obj, repairs)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push('Extracted value is not a JSON object.')
    return { ok: false }
  }
  return { ok: true, value: obj }
}

/**
 * Peel Claude CLI / Anthropic message envelopes, recursing into nested
 * payloads. Depth-guarded to stay safe on adversarial input.
 */
function unwrapEnvelope(value, repairs, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (depth > 8) return value

  // Claude CLI envelope: { type: "result", result: "<json string>" | object }
  if (value.type === 'result' && value.result !== undefined) {
    const inner = value.result
    if (typeof inner === 'string') {
      const parsed = extractFromString(inner, repairs, null)
      if (parsed !== undefined) {
        repairs.push('Unwrapped Claude CLI result envelope {type:"result"}.')
        return unwrapEnvelope(parsed, repairs, depth + 1)
      }
      repairs.push('Unwrapped Claude CLI result envelope with non-JSON result string.')
      return { result: inner }
    }
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      repairs.push('Unwrapped Claude CLI result envelope {type:"result"}.')
      return unwrapEnvelope(inner, repairs, depth + 1)
    }
  }

  // Anthropic SDK / wrapper envelope.
  if (value.structured_output !== undefined) {
    repairs.push('Unwrapped structured_output envelope.')
    return unwrapEnvelope(value.structured_output, repairs, depth + 1)
  }

  if (value.message && typeof value.message === 'object' && value.message.content !== undefined) {
    const content = value.message.content
    let text = ''
    if (Array.isArray(content)) {
      text = content
        .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
        .join('')
    } else if (typeof content === 'string') {
      text = content
    }
    if (text.trim()) {
      const parsed = extractFromString(text, repairs, null)
      if (parsed !== undefined) {
        repairs.push('Parsed JSON from message.content.')
        return unwrapEnvelope(parsed, repairs, depth + 1)
      }
    }
  }

  return value
}

/**
 * Pull a JSON object out of a string: fenced ```json block first, then a full
 * parse, then the first balanced {...}/[...] substring embedded in prose.
 * Returns the object or undefined.
 */
function extractFromString(text, repairs, errors) {
  const trimmed = String(text).trim()
  if (!trimmed) {
    if (errors) errors.push('Empty string input.')
    return undefined
  }

  const fenced = extractFencedJson(trimmed)
  if (fenced !== undefined) {
    repairs.push('Extracted JSON from fenced code block.')
    return fenced
  }

  const direct = tryParseObject(trimmed)
  if (direct !== undefined) return direct

  const balanced = extractBalancedJson(trimmed)
  if (balanced !== undefined) {
    repairs.push('Extracted JSON object from surrounding prose.')
    return balanced
  }

  if (errors) errors.push('Could not parse a JSON object from string input.')
  return undefined
}

function extractFencedJson(text) {
  const re = /```(?:[a-zA-Z0-9_+-]+)?\s*\n?([\s\S]*?)```/g
  let match
  while ((match = re.exec(text)) !== null) {
    const inner = match[1].trim()
    if (!inner) continue
    const parsed = tryParseObject(inner)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/**
 * Find the first '{' or '[' and scan to its matching close, respecting
 * string literals and escapes. Parses the slice; returns the object or
 * undefined.
 */
function extractBalancedJson(text) {
  const start = text.search(/[{[]/)
  if (start === -1) return undefined
  const opener = text[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === opener) depth++
    else if (ch === closer) {
      depth--
      if (depth === 0) {
        return tryParseObject(text.slice(start, i + 1))
      }
    }
  }
  return undefined
}

function tryParseObject(text) {
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize an extracted object into the agent-result contract. Returns null
 * only if `value` is not an object (should not normally happen here).
 */
function normalizeCandidate(value, repairs, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('Normalized candidate is not an object.')
    return null
  }

  const mapped = mapAlternateKeys(value, repairs)

  let status = mapStatus(mapped.status)
  if (!status) {
    if (mapped.status !== undefined) {
      repairs.push(`Coerced unrecognized status "${mapped.status}" to "partial".`)
    } else {
      repairs.push('Added default status "partial".')
    }
    status = 'partial'
  }

  let summary = pickSummary(mapped.summary)
  if (!summary) {
    summary = FALLBACK_SUMMARY
    repairs.push('Synthesized fallback summary.')
  }

  const filesChanged = normalizeFilesChanged(mapped.filesChanged)
  const commandsRun = normalizeCommands(mapped.commandsRun)
  const verification = normalizeVerification(mapped.verification, mapped.verificationEvidence, repairs)
  const risks = normalizeRisks(mapped.risks)
  const nextSteps = normalizeNextSteps(mapped.nextSteps)
  const tokenUsageSummary = normalizeTokenUsageSummary(mapped.tokenUsageSummary, repairs)
  const metrics = normalizeMetrics(mapped.metrics)

  const failedCheck = [...commandsRun, ...verification].some((item) => item.status === 'failed')
  if (status === 'completed' && failedCheck) {
    repairs.push('Downgraded status from "completed" to "failed" due to a failed check.')
    status = 'failed'
  }

  return {
    status,
    summary,
    filesChanged,
    commandsRun,
    verification,
    risks,
    nextSteps,
    tokenUsageSummary,
    metrics,
  }
}

function mapAlternateKeys(source, repairs) {
  const out = {}
  for (const [contract, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      if (source[alias] !== undefined) {
        out[contract] = source[alias]
        if (alias !== contract) {
          repairs.push(`Mapped alternate key "${alias}" to "${contract}".`)
        }
        break
      }
    }
  }

  // verificationEvidence is a partially mismatched key: when no verification
  // array is present, fold it into the verification entries as evidence.
  const evidence =
    source.verificationEvidence ?? source.verification_evidence ?? source.evidence
  if (evidence !== undefined) out.verificationEvidence = evidence

  // metrics / usage passthrough (counts are never fabricated here).
  if (source.metrics !== undefined) out.metrics = source.metrics
  else if (source.usage !== undefined) out.metrics = source.usage

  return out
}

function pickSummary(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['summary', 'text', 'message']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
  }
  return ''
}

function mapStatus(status) {
  const text = String(status ?? '').toLowerCase().trim()
  if (!text) return null
  if (STATUS_ENUM.includes(text)) return text
  if (['complete', 'passed', 'pass', 'success', 'succeeded', 'done', 'ok'].includes(text)) return 'completed'
  if (['partially_completed', 'partial_complete', 'in_progress', 'incomplete'].includes(text)) return 'partial'
  if (['stuck'].includes(text)) return 'blocked'
  if (['fail', 'error', 'errored'].includes(text)) return 'failed'
  return null
}

function mapCheckStatus(status) {
  const text = String(status ?? '').toLowerCase().trim()
  if (['passed', 'pass', 'success', 'succeeded', 'ok', 'completed', 'complete', 'done'].includes(text)) return 'passed'
  if (['failed', 'fail', 'error', 'errored'].includes(text)) return 'failed'
  if (['skipped', 'skip'].includes(text)) return 'skipped'
  return 'not_run'
}

function normalizeFilesChanged(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return { path: item, change: '' }
      if (!item || typeof item !== 'object') return null
      return {
        path: String(item.path || item.file || item.filename || ''),
        change: String(item.change || item.description || item.summary || item.action || ''),
      }
    })
    .filter((item) => item && item.path)
}

function normalizeCommands(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return { command: item, status: 'not_run' }
      if (!item || typeof item !== 'object') return null
      const out = {
        command: String(item.command || item.cmd || item.name || ''),
        status: mapCheckStatus(item.status),
      }
      const notes = item.notes || item.detail || item.evidence || ''
      if (notes) out.notes = String(notes)
      return out
    })
    .filter((item) => item && item.command)
}

function normalizeVerification(value, evidence, repairs) {
  let arr = Array.isArray(value) ? value : []
  if (!arr.length && evidence !== undefined) {
    repairs.push('Built verification entries from "verificationEvidence".')
    const evArr = Array.isArray(evidence) ? evidence : [evidence]
    arr = evArr.map((entry) => (typeof entry === 'string' ? { check: 'verification', evidence: entry } : entry))
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map((item) => {
      if (typeof item === 'string') return { check: item, status: 'not_run' }
      if (!item || typeof item !== 'object') return null
      const check = String(item.check || item.name || item.title || item.label || 'verification')
      const out = { check, status: mapCheckStatus(item.status) }
      const ev = item.evidence || item.detail || item.notes || ''
      if (ev) out.evidence = String(ev)
      return out
    })
    .filter((item) => item && item.check)
}

function normalizeRisks(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return { risk: item, severity: 'low' }
      if (!item || typeof item !== 'object') return null
      const out = {
        risk: String(item.risk || item.description || item.summary || item.issue || ''),
        severity: SEVERITY_ENUM.includes(item.severity) ? item.severity : 'low',
      }
      const mitigation = item.mitigation || ''
      if (mitigation) out.mitigation = String(mitigation)
      return out
    })
    .filter((item) => item && item.risk)
}

function normalizeNextSteps(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') return String(item.step || item.action || '')
      return String(item ?? '')
    })
    .filter(Boolean)
}

function normalizeTokenUsageSummary(value, repairs) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['summary', 'note', 'text', 'message']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
  }
  repairs.push('Filled tokenUsageSummary with "not visible" placeholder; no exact counts fabricated.')
  return TOKEN_NOT_VISIBLE
}

/**
 * Pass through metrics as-is. Only primitive values are retained so we never
 * carry malformed nested shapes; numbers are never invented.
 */
function normalizeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
      out[key] = val
    }
  }
  return out
}

// Exported for direct testing of the extraction layer.
export const _internals = {
  extractCandidate,
  unwrapEnvelope,
  extractFromString,
  normalizeCandidate,
  mapAlternateKeys,
}

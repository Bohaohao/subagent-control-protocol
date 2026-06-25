import path from 'node:path'

// File-ownership / diff validation for subagent tasks.
//
// This module is intentionally pure: it never shells out to git and performs
// no filesystem access. It derives declared file boundaries from task metadata
// (preferring explicit fields) and reports violations/warnings for files that a
// task touched outside those boundaries, plus cross-task collisions across a run.
//
// Integration points (scheduler/summary) will be added later; for now the API is
// self-contained and side-effect free.

const READ_ONLY_KINDS = new Set(['review', 'verify'])

// Normalize a single path segment list, resolving `.` and `..` purely (no fs).
function resolveSegments(segments) {
  const out = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // Never pop above the root segment (a drive letter or leading empty
      // for posix-absolute paths); just drop the `..`.
      if (out.length && out[out.length - 1] !== '..' && !/^[A-Za-z]:$/.test(out[out.length - 1])) {
        out.pop()
      }
      continue
    }
    out.push(seg)
  }
  return out
}

/**
 * Normalize a path to a forward-slash, workspace-relative form where possible.
 *
 * - Backslashes are converted to forward slashes (Windows friendly).
 * - `.` and `..` segments are resolved purely.
 * - When `workspace` is provided and the path lives under it, the returned
 *   value is relative to the workspace.
 * - Trailing slashes are dropped.
 *
 * The returned value is a *display* form (original case preserved). Use
 * {@link pathKey} for a case-insensitive comparison key.
 *
 * @param {string} rawPath
 * @param {string} [workspace]
 * @returns {string}
 */
export function normalizePath(rawPath, workspace) {
  if (!rawPath || typeof rawPath !== 'string') return ''
  let text = rawPath.replace(/\\/g, '/')

  // Split off a leading drive letter / UNC host so it survives `.`/`..` resolution.
  let prefix = ''
  const driveMatch = text.match(/^([A-Za-z]:)(\/?)(.*)$/)
  const uncMatch = !driveMatch && text.match(/^(\/\/[^/]+\/[^/]*)(\/?)(.*)$/)
  if (driveMatch) {
    prefix = driveMatch[1] + '/'
    text = driveMatch[3]
  } else if (uncMatch) {
    prefix = uncMatch[1] + '/'
    text = uncMatch[3]
  }

  const absolute = text.startsWith('/')
  const segments = resolveSegments(text.split('/'))
  let normalized = (absolute ? '/' : '') + segments.join('/')
  if (prefix) normalized = prefix + normalized.replace(/^\//, '')

  if (workspace) {
    const wsKey = pathKey(normalizePath(workspace))
    const key = pathKey(normalized)
    if (key === wsKey) return '.'
    if (key.startsWith(wsKey + '/')) {
      return normalized.slice(pathKeyDisplayLength(workspace) + 1)
    }
  }
  return normalized || '.'
}

// Length of the workspace display form (used to slice the relative portion).
// Recomputed from normalizePath so the slice stays in sync with the display form
// rather than the lowercased key.
function pathKeyDisplayLength(workspace) {
  return normalizePath(workspace).length
}

/**
 * Return a case-insensitive comparison key for a normalized path.
 *
 * Windows file systems are case-insensitive, so two paths differing only in
 * casing are treated as the same file. Lowercasing the whole path is the
 * simplest robust rule for this kit's Windows-oriented workflow.
 *
 * @param {string} normalizedPath
 * @returns {string}
 */
export function pathKey(normalizedPath) {
  return String(normalizedPath || '').toLowerCase()
}

// Coerce a list of "changed file" entries (strings or {path,...} objects) into
// normalized display paths. Mirrors the shapes accepted by result-normalizer.
function coerceChangedFiles(value, workspace) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const raw = typeof item === 'string' ? item : String(item?.path || item?.file || item?.filePath || '')
    const normalized = normalizePath(raw, workspace)
    if (normalized) out.push(normalized)
  }
  return out
}

/**
 * Derive declared file ownership for a task.
 *
 * Explicit fields always win:
 *   - `task.ownedFiles`   - files the task is permitted to modify.
 *   - `task.allowedFiles` - additional files permitted (treated like ownedFiles).
 *   - `task.readOnly`     - when true, no file edits are allowed.
 *
 * When explicit lists are absent, a best-effort scan of `task.prompt` extracts
 * an "Owned files:" / "Edit no other file" style declaration. The derivation
 * never throws; an undeclared task simply yields empty lists with source 'none'.
 *
 * @param {object} task
 * @returns {{ ownedFiles: string[], allowedFiles: string[], readOnly: boolean, source: 'explicit'|'prompt'|'none'|'mixed', workspace?: string }}
 */
export function deriveTaskOwnership(task) {
  const t = task || {}
  const workspace = t.workspace

  const explicitOwned = coerceFileList(t.ownedFiles, workspace)
  const explicitAllowed = coerceFileList(t.allowedFiles, workspace)
  const explicitReadOnly = t.readOnly === true

  const kindReadOnly = READ_ONLY_KINDS.has(String(t.kind || '').toLowerCase())
  const readOnly = explicitReadOnly || kindReadOnly

  let source = 'none'
  const explicitPresent = explicitOwned.length || explicitAllowed.length || t.readOnly === true
  let ownedFiles = explicitOwned
  let allowedFiles = explicitAllowed

  if (!explicitOwned.length && !explicitAllowed.length) {
    const fromPrompt = parseOwnedFilesFromPrompt(t.prompt, workspace)
    if (fromPrompt.length) {
      ownedFiles = fromPrompt
      source = 'prompt'
    }
  }

  if (explicitPresent && source === 'prompt') source = 'mixed'
  else if (explicitPresent) source = 'explicit'

  return { ownedFiles, allowedFiles, readOnly, source, workspace }
}

// Normalize a user-supplied file list (strings or objects with a path) against
// the task workspace.
function coerceFileList(value, workspace) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const raw = typeof item === 'string' ? item : String(item?.path || item?.file || item?.filePath || '')
    const normalized = normalizePath(raw, workspace)
    if (normalized) out.push(normalized)
  }
  return out
}

// Best-effort extraction of an owned-files declaration from a task prompt.
// Recognizes patterns like:
//   "Owned files: src/a.mjs, src/b.mjs only."
//   "Files you may edit: src/a.mjs"
//   "Edit only these files: src/a.mjs and src/b.mjs"
// We capture to end-of-line (paths contain dots, so `.` cannot be a terminator)
// and trim trailing sentence noise afterwards.
const OWNED_PROMPT_RE = /(?:owned\s*files?|files?\s+you\s+(?:may|can)\s+edit|edit\s+(?:only\s+)?(?:these\s+)?files?)\s*[:\uFF1A]\s*([^\n]+)/i

function parseOwnedFilesFromPrompt(prompt, workspace) {
  if (typeof prompt !== 'string' || !prompt) return []
  const match = prompt.match(OWNED_PROMPT_RE)
  if (!match) return []
  // Strip trailing sentence noise ("only.", "only", trailing period) without
  // touching dots that belong to file extensions earlier in the line.
  const cleaned = match[1]
    .replace(/\s*\bonly\b\.?/gi, '')
    .replace(/[.;\s]+$/, '')
    .trim()
  const list = cleaned
    .split(/,|\n|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
  return coerceFileList(list, workspace)
}

// Build a quick-lookup set of comparison keys from a list of normalized paths.
function keySet(paths) {
  const set = new Set()
  for (const p of paths) set.add(pathKey(p))
  return set
}

/**
 * Validate that a single task's changed files stay within its declared boundaries.
 *
 * @param {{ task: object, result?: object, changedFiles?: Array<string|object>, workspace?: string }} args
 * @returns {{ violations: Array<object>, warnings: Array<object> }}
 */
export function validateTaskFileOwnership({ task, result, changedFiles, workspace } = {}) {
  const t = task || {}
  const ws = workspace || t.workspace
  const ownership = deriveTaskOwnership({ ...t, workspace: ws })

  const rawChanged = changedFiles ?? result?.filesChanged ?? result?.files_changed ?? []
  const changed = coerceChangedFiles(rawChanged, ws)

  const violations = []
  const warnings = []

  if (!changed.length) {
    return { violations, warnings }
  }

  const allowedKeys = keySet([...ownership.ownedFiles, ...ownership.allowedFiles])

  for (const file of changed) {
    if (ownership.readOnly) {
      violations.push({
        type: 'read_only_task_edit',
        taskId: t.id,
        path: file,
        message: `Read-only task "${t.id}" modified file ${file}.`,
      })
      continue
    }

    if (ownership.source === 'none') {
      // No declared boundary to check against: surface as a warning so callers
      // can decide whether undeclared edits are acceptable.
      warnings.push({
        type: 'ownership_undeclared',
        taskId: t.id,
        path: file,
        message: `Task "${t.id}" has no declared file ownership; cannot verify ${file}.`,
      })
      continue
    }

    if (!allowedKeys.has(pathKey(file))) {
      violations.push({
        type: 'file_outside_ownership',
        taskId: t.id,
        path: file,
        message: `Task "${t.id}" modified ${file}, which is outside its declared owned/allowed files.`,
      })
    }
  }

  return { violations, warnings }
}

// Coerce a results collection into a list of { taskId, filesChanged } entries.
// Accepts an array of results or an object keyed by taskId.
function coerceResults(results, workspace) {
  const entries = []
  if (Array.isArray(results)) {
    for (const r of results) {
      if (!r) continue
      entries.push({
        taskId: r.taskId || r.id || r.task_id || null,
        filesChanged: coerceChangedFiles(changedFilesFromResult(r), workspace),
      })
    }
  } else if (results && typeof results === 'object') {
    for (const [taskId, r] of Object.entries(results)) {
      if (!r) continue
      entries.push({
        taskId: r.taskId || r.id || taskId,
        filesChanged: coerceChangedFiles(changedFilesFromResult(r), workspace),
      })
    }
  }
  return entries
}

function changedFilesFromResult(result) {
  if (!result || typeof result !== 'object') return []
  return result.filesChanged
    || result.files_changed
    || result.changedFiles
    || result.parsed?.filesChanged
    || result.parsed?.files_changed
    || result.parsed?.changedFiles
    || []
}

/**
 * Validate file ownership across an entire run.
 *
 * Detects:
 *   - cross-task file collisions (the same file modified by >1 task),
 *   - read-only task edits,
 *   - per-task out-of-ownership edits (delegated to {@link validateTaskFileOwnership}).
 *
 * `tasks` is the normalized task list (used for ownership/declarations);
 * `results` is an array or taskId-keyed map of normalized results.
 *
 * @param {{ tasks: Array<object>, results: Array<object>|object, workspace?: string }} args
 * @returns {{ violations: Array<object>, warnings: Array<object>, collisions: Array<object> }}
 */
export function validateRunFileOwnership({ tasks, results, workspace } = {}) {
  const taskList = Array.isArray(tasks) ? tasks : []
  const ws = workspace
  const taskById = new Map()
  for (const t of taskList) {
    if (t && t.id) taskById.set(String(t.id), t)
  }

  const resultEntries = coerceResults(results, ws)
  const violations = []
  const warnings = []
  const collisions = []

  // Per-task ownership checks.
  for (const entry of resultEntries) {
    if (!entry.taskId) continue
    const task = taskById.get(String(entry.taskId)) || { id: entry.taskId, workspace: ws }
    const { violations: v, warnings: w } = validateTaskFileOwnership({
      task,
      changedFiles: entry.filesChanged,
      workspace: ws,
    })
    violations.push(...v)
    warnings.push(...w)
  }

  // Cross-task collisions: which taskIds touched each file key.
  const ownersByKey = new Map()
  for (const entry of resultEntries) {
    if (!entry.taskId) continue
    for (const file of entry.filesChanged) {
      const key = pathKey(file)
      if (!ownersByKey.has(key)) ownersByKey.set(key, { path: file, tasks: new Set() })
      ownersByKey.get(key).tasks.add(String(entry.taskId))
    }
  }

  for (const { path: file, tasks: taskSet } of ownersByKey.values()) {
    if (taskSet.size > 1) {
      const taskIds = [...taskSet]
      collisions.push({
        type: 'file_collision',
        path: file,
        taskIds,
        message: `File ${file} was modified by ${taskIds.length} tasks: ${taskIds.join(', ')}.`,
      })
      violations.push({
        type: 'file_collision',
        path: file,
        taskIds,
        message: `File ${file} was modified by ${taskIds.length} tasks: ${taskIds.join(', ')}.`,
      })
    }
  }

  return { violations, warnings, collisions }
}

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function createRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + os.EOL, 'utf8')
}

export function safeJsonParse(value) {
  const text = typeof value === 'string' ? value.trim() : value
  if (!text) return { ok: false, error: 'empty output' }
  if (typeof text !== 'string') return { ok: true, value: text }

  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    const lineParsed = parseLastJsonLine(text)
    if (lineParsed.ok) return lineParsed
    return { ok: false, error: error.message }
  }
}

function parseLastJsonLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()

  for (const line of lines) {
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try {
      return { ok: true, value: JSON.parse(line) }
    } catch {
      // Keep looking for a parseable JSON event line.
    }
  }

  return { ok: false, error: 'no parseable JSON line' }
}

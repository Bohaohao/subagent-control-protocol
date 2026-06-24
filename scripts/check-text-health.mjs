#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const root = path.resolve(String(args.root || process.cwd()))
  const outPath = args.out ? path.resolve(String(args.out)) : path.join(root, '.agent-checks', 'text-health-report.json')
  const extensions = new Set(asArray(args.include).length ? asArray(args.include) : [
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.ts',
  ])
  const skipDirs = new Set([
    '.agent-runs',
    '.agent-checks',
    '.scp-runs',
    '.subagent-runs',
    '.git',
    'dist',
    'node_modules',
    'coverage',
  ])

  const files = await collectFiles(root, extensions, skipDirs)
  const issues = []
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const fileIssues = inspectText(text)
    if (fileIssues.length) {
      issues.push({
        file: path.relative(root, file).replace(/\\/g, '/'),
        issueCount: fileIssues.length,
        issues: fileIssues.slice(0, 20),
      })
    }
  }

  const report = {
    root,
    checkedAt: new Date().toISOString(),
    filesChecked: files.length,
    issueFiles: issues.length,
    issues,
    passed: issues.length === 0,
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, JSON.stringify(report, null, 2) + os.EOL, 'utf8')
  process.stdout.write(JSON.stringify(report, null, 2) + os.EOL)

  if (!report.passed) {
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
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    if (out[key] === undefined) {
      out[key] = value
    } else if (Array.isArray(out[key])) {
      out[key].push(value)
    } else {
      out[key] = [out[key], value]
    }
  }
  return out
}

function printHelp() {
  console.log(`Usage:
  node scripts/check-text-health.mjs --root PROJECT --out PROJECT/.agent-checks/text-health-report.json

Options:
  --root PATH        Directory to scan. Defaults to cwd.
  --out PATH         JSON report path.
  --include .vue     File extension to include. Repeatable.
`)
}

function asArray(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

async function collectFiles(root, extensions, skipDirs) {
  const files = []

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (extensions.has(path.extname(entry.name))) files.push(fullPath)
    }
  }

  await walk(root)
  return files
}

function inspectText(text) {
  const cp = (...codes) => String.fromCodePoint(...codes)
  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const latinTokens = [
    `${escapeRe(cp(0x00c3))}.`,
    `${escapeRe(cp(0x00c2))}.`,
    `${escapeRe(cp(0x00e2, 0x20ac))}.`,
    escapeRe(cp(0x00e2, 0x20ac, 0x2122)),
    escapeRe(cp(0x00e2, 0x20ac, 0x0153)),
    escapeRe(cp(0x00e2, 0x20ac, 0xfffd)),
    escapeRe(cp(0x00e2, 0x20ac, 0x201c)),
    escapeRe(cp(0x00e2, 0x20ac, 0x201d)),
  ]
  const cjkTokens = [
    cp(0x9225),
    cp(0x951b),
    cp(0x9286),
    cp(0x9410),
    cp(0x6d93),
    cp(0x6dc7),
    cp(0x9359),
    cp(0x8bf2),
    cp(0x8930),
    cp(0x95c8),
    cp(0x7ec0),
    cp(0x9352),
    cp(0x7af7),
    cp(0x7cb0),
    cp(0x5d1f),
    cp(0x6d30),
    cp(0x5ae8),
    cp(0x5f42),
    cp(0x726c),
    cp(0x5e3a),
    cp(0x55d9),
    cp(0x621d),
  ].map(escapeRe)

  const patterns = [
    { id: 'replacement-character', regex: new RegExp(escapeRe(cp(0xfffd)), 'g') },
    { id: 'latin1-mojibake', regex: new RegExp(`(?:${latinTokens.join('|')})`, 'g') },
    { id: 'cjk-mojibake-token', regex: new RegExp(`(?:${cjkTokens.join('|')})`, 'g') },
  ]

  const issues = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const index = match.index ?? 0
      const line = 1 + text.slice(0, index).split(/\r?\n/).length - 1
      issues.push({
        type: pattern.id,
        line,
        match: match[0],
        snippet: snippetAround(text, index),
      })
      if (issues.length >= 200) return issues
    }
  }
  return issues
}

function snippetAround(text, index) {
  const start = Math.max(0, index - 40)
  const end = Math.min(text.length, index + 80)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

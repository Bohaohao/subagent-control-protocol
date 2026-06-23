#!/usr/bin/env node
import { spawn } from 'node:child_process'
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

  const project = path.resolve(String(args.project || process.cwd()))
  const port = Number(args.port || 4179)
  const url = String(args.url || `http://127.0.0.1:${port}/`)
  const expectedTexts = asArray(args['expected-text']).map(String)
  const reportPath = args.out ? path.resolve(String(args.out)) : path.join(project, '.agent-checks', 'frontend-verify-report.json')
  const screenshotPath = args.screenshot ? path.resolve(String(args.screenshot)) : path.join(project, '.agent-checks', 'frontend-smoke.png')
  const buildCommand = String(args['build-command'] || 'npm run build')
  const serveCommand = String(args['serve-command'] || `npm run dev -- --host 127.0.0.1 --port ${port}`)
  const timeoutMs = Number(args.timeout || 120000)
  const chromePath = await findChrome(String(args.chrome || ''))
  const checks = []
  let server = null

  try {
    if (!args['skip-build']) {
      const build = await runShell(buildCommand, project, timeoutMs)
      checks.push({
        check: 'build',
        status: build.exitCode === 0 ? 'passed' : 'failed',
        command: buildCommand,
        exitCode: build.exitCode,
        stderrTail: tail(build.stderr),
      })
      if (build.exitCode !== 0) {
        throw new Error(`Build failed: ${buildCommand}`)
      }
    } else {
      checks.push({ check: 'build', status: 'skipped', command: buildCommand })
    }

    if (!args.url) {
      server = startServer(serveCommand, project)
      await waitForUrl(url, timeoutMs)
      checks.push({ check: 'serve', status: 'passed', command: serveCommand, url })
    } else {
      await waitForUrl(url, timeoutMs)
      checks.push({ check: 'serve', status: 'passed', command: 'external-url', url })
    }

    await fs.mkdir(path.dirname(screenshotPath), { recursive: true })
    const dump = await runProcess(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--window-size=1440,900',
      '--virtual-time-budget=5000',
      '--dump-dom',
      url,
    ], project, timeoutMs)

    checks.push({
      check: 'headless-dom',
      status: dump.exitCode === 0 ? 'passed' : 'failed',
      exitCode: dump.exitCode,
      stderrTail: tail(dump.stderr),
    })
    if (dump.exitCode !== 0) {
      throw new Error('Headless Chrome DOM dump failed')
    }

    for (const expected of expectedTexts) {
      checks.push({
        check: `expected-text:${expected}`,
        status: dump.stdout.includes(expected) ? 'passed' : 'failed',
      })
    }

    const screenshot = await runProcess(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--window-size=1440,900',
      '--virtual-time-budget=5000',
      `--screenshot=${screenshotPath}`,
      url,
    ], project, timeoutMs)

    checks.push({
      check: 'screenshot',
      status: screenshot.exitCode === 0 ? 'passed' : 'failed',
      screenshotPath,
      exitCode: screenshot.exitCode,
      stderrTail: tail(screenshot.stderr),
    })
  } finally {
    if (server && !args['keep-server']) {
      await killProcessTree(server.pid)
    }
  }

  const passed = checks.every((check) => ['passed', 'skipped'].includes(check.status))
  const report = {
    project,
    checkedAt: new Date().toISOString(),
    url,
    chromePath,
    screenshotPath,
    checks,
    passed,
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + os.EOL, 'utf8')
  process.stdout.write(JSON.stringify(report, null, 2) + os.EOL)

  if (!passed) process.exitCode = 1
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
  node scripts/verify-vite-app.mjs --project PROJECT --expected-text PixiJS --screenshot smoke.png

Options:
  --project PATH           Project directory. Defaults to cwd.
  --url URL                Use an already running server instead of starting Vite.
  --port N                 Dev server port when --url is omitted. Default: 4179.
  --expected-text TEXT     Text expected in rendered DOM. Repeatable.
  --screenshot PATH        Screenshot output path.
  --out PATH               JSON report path.
  --skip-build             Skip build command.
  --build-command CMD      Default: npm run build.
  --serve-command CMD      Default: npm run dev -- --host 127.0.0.1 --port N.
  --chrome PATH            Chrome executable path.
  --keep-server            Leave dev server running.
`)
}

function asArray(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function runShell(command, cwd, timeoutMs) {
  return runSpawn(command, [], cwd, timeoutMs, true)
}

function runProcess(command, args, cwd, timeoutMs) {
  return runSpawn(command, args, cwd, timeoutMs, false)
}

function runSpawn(command, args, cwd, timeoutMs, shell) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(async () => {
      await killProcessTree(child.pid)
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({ exitCode: 1, stdout, stderr: stderr + os.EOL + String(error) })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout)
      resolve({ exitCode, signal, stdout, stderr })
    })
  })
}

function startServer(command, cwd) {
  const child = spawn(command, [], {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

async function waitForUrl(url, timeoutMs) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'unknown error'}`)
}

async function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'chrome',
    'chrome.exe',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        continue
      }
    }
    const probe = await runSpawn(candidate, ['--version'], process.cwd(), 10000, false)
    if (probe.exitCode === 0) return candidate
  }
  throw new Error('Could not find Chrome. Pass --chrome PATH or set CHROME_PATH.')
}

async function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('close', resolve)
      killer.on('error', resolve)
    })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already exited.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tail(text, max = 1200) {
  if (!text) return ''
  return text.length > max ? text.slice(text.length - max) : text
}


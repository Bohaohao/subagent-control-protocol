import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'

export async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export function captureProcess(command, args = [], cwd = process.cwd(), timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }, timeoutMs)

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({ exitCode: 1, stdout, stderr: stderr + os.EOL + String(error), signal: null })
    })
    child.on('close', (exitCode, signal) => {
      finish({ exitCode, stdout, stderr, signal })
    })
  })
}

export async function killProcessTree(pid) {
  if (!pid) return false

  if (process.platform === 'win32') {
    return killWindowsTree(pid)
  }

  return killUnixTree(pid)
}

function killWindowsTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      resolve(ok)
    }
    killer.on('close', (code) => finish(code === 0 || code === 128))
    killer.on('error', () => finish(false))
  })
}

async function killUnixTree(pid) {
  // Collect descendants first (children before parents), then signal the whole
  // tree. SIGTERM first, then escalate to SIGKILL if anything is still alive.
  const pids = [pid, ...(await collectDescendants(pid))].reverse()
  for (const target of pids) {
    try {
      process.kill(target, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1500))

  for (const target of pids) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // Already gone, or not ours.
    }
  }
  return true
}

async function collectDescendants(pid, seen = new Set()) {
  if (seen.has(pid)) return []
  seen.add(pid)
  let children = []
  try {
    const result = await captureProcess('pgrep', ['-P', String(pid)], process.cwd(), 5000)
    if (result.exitCode === 0) {
      children = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isInteger(value))
    }
  } catch {
    // pgrep unavailable; best-effort single-process kill only.
    return []
  }

  const all = []
  for (const child of children) {
    all.push(child, ...(await collectDescendants(child, seen)))
  }
  return all
}

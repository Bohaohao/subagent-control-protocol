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
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('close', resolve)
      killer.on('error', resolve)
    })
    return true
  }

  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

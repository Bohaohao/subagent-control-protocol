#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runTaskPlan } from '../src/core/scheduler.mjs'

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.plan) {
    printHelp()
    process.exit(args.help ? 0 : 1)
  }

  const planPath = path.resolve(String(args.plan))
  const planDir = path.dirname(planPath)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  const summary = await runTaskPlan(plan, {
    planDir,
    workspace: args.workspace || plan.workspace,
    outputDir: args.out || plan.outputDir,
    concurrency: args.concurrency || plan.concurrency,
    dryRun: Boolean(args['dry-run']),
    claudeExecutable: args.claude,
  })

  process.stdout.write(JSON.stringify(summary, null, 2) + os.EOL)
  if (summary.failedTasks || summary.timedOutTasks || summary.blockedTasks) {
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

    const eq = token.indexOf('=')
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }

    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-claude-agents.mjs --plan PLAN.json [--concurrency 2] [--dry-run]

Options:
  --plan PATH         Task plan JSON file.
  --workspace PATH    Override plan workspace.
  --out PATH          Override output directory.
  --concurrency N     Max parallel Claude tasks.
  --claude PATH       Override Claude executable.
  --dry-run           Write prompts and commands without invoking Claude.
`)
}

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectEnv } from '@/engine/child-env'
import { redact } from '@/engine/redact'

// The evidence producer. What it records came from a process, not from a model: an exit code, a duration and, when
// the runner printed a summary it recognises, the counts. When it cannot read counts it records none — it never
// guesses them.

export type TestCounts = { passed: number; failed: number; total: number }
export type TestRun = {
  command: string
  /** Null when the command did not exit on its own: it was stopped, killed by a signal, or never started. */
  exitCode: number | null
  /** The signal that killed it (an out-of-memory kill, a crash), when that is how it ended. Null otherwise. */
  signal: string | null
  /** False only when the command could not be started at all: nothing ran, so there is nothing measured. */
  started: boolean
  durationMs: number
  counts: TestCounts | null
  /** The end of what the command printed, redacted. Stored as evidence, never put in an event. */
  outputTail: string
  /**
   * Test files or test configuration this run changed since its base commit. The agent works unattended and could
   * rewrite the very tests that judge it, so a pass is only worth as much as this list is short. Null: not checked.
   */
  changedTestFiles: string[] | null
}

const TAIL_CHARS = 4000

// Each runner prints its own summary, and a workspace run (pnpm -r, npm --workspaces, turbo) prints one per package,
// often with the package name in front. Every summary found is added up: reading only the first would report one
// package's numbers as the whole run's. Lines are matched anywhere, so a "pkg test:" prefix does not hide them.
const VITEST = /Tests\s+((?:\d+\s+(?:passed|failed|skipped|todo)\s*\|?\s*)+)\((\d+)\)/g
const JEST = /Tests:\s+([^\n]*?)(\d+)\s+total/g
const NODE_TALLY = (word: string) => new RegExp(`(?:^|\\s)(?:#|ℹ)\\s+${word}\\s+(\\d+)\\s*$`, 'gm')

const part = (text: string, word: string) => Number(text.match(new RegExp(`(\\d+)\\s+${word}`))?.[1] ?? 0)

// Terminal colour and cursor codes. Runners print them even when asked not to, and they sit between the words.
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

export function parseCounts(raw: string): TestCounts | null {
  const output = stripAnsi(raw)
  const sum = { passed: 0, failed: 0, total: 0 }
  let found = false
  for (const m of output.matchAll(VITEST)) {
    sum.passed += part(m[1]!, 'passed')
    sum.failed += part(m[1]!, 'failed')
    sum.total += Number(m[2])
    found = true
  }
  for (const m of output.matchAll(JEST)) {
    sum.passed += part(m[1]!, 'passed')
    sum.failed += part(m[1]!, 'failed')
    sum.total += Number(m[2])
    found = true
  }
  // node --test: one "tests / pass / fail" tally per run. Only complete tallies count.
  const tally = (word: string) => [...output.matchAll(NODE_TALLY(word))].map(m => Number(m[1]))
  const [tests, pass, fail] = [tally('tests'), tally('pass'), tally('fail')]
  if (tests.length > 0 && tests.length === pass.length && tests.length === fail.length) {
    const add = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    sum.passed += add(pass)
    sum.failed += add(fail)
    sum.total += add(tests)
    found = true
  }
  return found ? sum : null
}

/** Runs the project's configured test command. That string is the allow-list: nothing else is ever run here. */
export function runTestCommand(command: string, cwd: string, signal: AbortSignal, env: Record<string, string> = {}): Promise<TestRun> {
  const started = Date.now()
  return new Promise(resolve => {
    let output = ''
    // Its own process group, so stopping it also stops whatever the command started (a test runner's workers).
    const child = spawn('sh', ['-c', command], { cwd, detached: true, env: projectEnv({ CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env }) })
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-TAIL_CHARS * 4)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)

    let stopped = false
    const stop = () => {
      stopped = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })

    const finish = (code: number | null, killedBy: string | null, began: boolean) => {
      signal.removeEventListener('abort', stop)
      // Counts read from the raw output, then the output is redacted before it is kept anywhere.
      const counts = stopped ? null : parseCounts(output)
      resolve({
        command,
        exitCode: stopped ? null : code,
        // A kill the runner itself sent on abort is a cancellation, not something the tests did.
        signal: stopped ? null : killedBy,
        started: began,
        durationMs: Date.now() - started,
        counts,
        outputTail: redact(stripAnsi(output)).slice(-TAIL_CHARS),
        changedTestFiles: null,
      })
    }
    child.on('error', () => finish(null, null, false))
    child.on('close', (code, killedBy) => finish(code, killedBy, true))
  })
}

// What decides whether tests pass: the tests themselves, the command that runs them, and the runner's configuration.
const TEST_DEFINITION: readonly RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)(__tests__|tests?|spec|e2e)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(vitest|jest|playwright|mocha|karma|cypress)\.config\.[cm]?[jt]s$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)(test_[^/]*|[^/]*_test)\.py$/,
  /(^|\/)(pytest\.ini|conftest\.py|tox\.ini)$/,
  /_test\.go$/,
  /(^|\/)Makefile$/,
]

export function isTestDefinition(path: string): boolean {
  return TEST_DEFINITION.some(re => re.test(path))
}

/** Every test-defining file changed in the worktree since `baseCommit`, committed or not, tracked or new. */
export function changedTestFiles(cwd: string, baseCommit: string | undefined): string[] | null {
  if (!baseCommit) return null
  try {
    const run = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const changed = run(['diff', '--name-only', baseCommit]).split('\n')
    const added = run(['ls-files', '--others', '--exclude-standard']).split('\n')
    return [...new Set([...changed, ...added].map(l => l.trim()).filter(Boolean))].filter(isTestDefinition).sort()
  } catch {
    return null
  }
}

const NPM_PLACEHOLDER = /no test specified/

/** The obvious test command for a repository, or null. A suggestion the person confirms, never run unasked. */
export function detectTestCommand(repoPath: string): string | null {
  const file = join(repoPath, 'package.json')
  if (!existsSync(file)) return null
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: { test?: unknown } }
    const test = pkg.scripts?.test
    if (typeof test !== 'string' || test.trim() === '' || NPM_PLACEHOLDER.test(test)) return null
    // Run the script the way the project installs: a pnpm project's tests expect pnpm's node_modules layout.
    const has = (f: string) => existsSync(join(repoPath, f))
    if (has('pnpm-lock.yaml')) return 'pnpm test'
    if (has('yarn.lock')) return 'yarn test'
    if (has('bun.lockb') || has('bun.lock')) return 'bun run test'
    return 'npm test'
  } catch {
    return null
  }
}

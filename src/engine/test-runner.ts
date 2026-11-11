import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '@/engine/redact'

// The evidence producer. What it records came from a process, not from a model: an exit code, a duration and, when
// the runner printed a summary it recognises, the counts. When it cannot read counts it records none — it never
// guesses them.

export type TestCounts = { passed: number; failed: number; total: number }
export type TestRun = {
  command: string
  /** Null when the command never finished (it was stopped). */
  exitCode: number | null
  durationMs: number
  counts: TestCounts | null
  /** The end of what the command printed, redacted. Stored as evidence, never put in an event. */
  outputTail: string
}

const TAIL_CHARS = 4000

export function parseCounts(output: string): TestCounts | null {
  // vitest: "Tests  3 passed | 1 failed (4)" in either order, or "Tests  4 passed (4)".
  const vitest = output.match(/Tests\s+((?:\d+\s+(?:passed|failed|skipped|todo)\s*\|?\s*)+)\((\d+)\)/)
  if (vitest) {
    const part = (word: string) => Number(vitest[1]!.match(new RegExp(`(\\d+)\\s+${word}`))?.[1] ?? 0)
    return { passed: part('passed'), failed: part('failed'), total: Number(vitest[2]) }
  }
  // jest: "Tests:       1 failed, 3 passed, 4 total".
  const jest = output.match(/Tests:\s+([^\n]*?)(\d+)\s+total/)
  if (jest) {
    const part = (word: string) => Number(jest[1]!.match(new RegExp(`(\\d+)\\s+${word}`))?.[1] ?? 0)
    return { passed: part('passed'), failed: part('failed'), total: Number(jest[2]) }
  }
  // node --test: "# tests 4 / # pass 3 / # fail 1" (TAP reporter) or "ℹ tests 4 / ℹ pass 3 / ℹ fail 1" (spec reporter).
  const tally = (word: string) => output.match(new RegExp(`^(?:#|ℹ)\\s+${word}\\s+(\\d+)\\s*$`, 'm'))?.[1]
  const [tests, pass, fail] = [tally('tests'), tally('pass'), tally('fail')]
  if (tests !== undefined && pass !== undefined && fail !== undefined) return { passed: Number(pass), failed: Number(fail), total: Number(tests) }
  return null
}

/** Runs the project's configured test command. That string is the allow-list: nothing else is ever run here. */
export function runTestCommand(command: string, cwd: string, signal: AbortSignal): Promise<TestRun> {
  const started = Date.now()
  return new Promise(resolve => {
    let output = ''
    // Its own process group, so stopping it also stops whatever the command started (a test runner's workers).
    const child = spawn('sh', ['-c', command], { cwd, detached: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } })
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

    const finish = (code: number | null) => {
      signal.removeEventListener('abort', stop)
      // Counts read from the raw output, then the output is redacted before it is kept anywhere.
      const counts = stopped ? null : parseCounts(output)
      resolve({ command, exitCode: stopped ? null : code, durationMs: Date.now() - started, counts, outputTail: redact(output).slice(-TAIL_CHARS) })
    }
    child.on('error', () => finish(null))
    child.on('close', code => finish(code))
  })
}

const NPM_PLACEHOLDER = /no test specified/

/** The obvious test command for a repository, or null. A suggestion the person confirms, never run unasked. */
export function detectTestCommand(repoPath: string): string | null {
  const file = join(repoPath, 'package.json')
  if (!existsSync(file)) return null
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: { test?: unknown } }
    const test = pkg.scripts?.test
    return typeof test === 'string' && test.trim() !== '' && !NPM_PLACEHOLDER.test(test) ? 'npm test' : null
  } catch {
    return null
  }
}

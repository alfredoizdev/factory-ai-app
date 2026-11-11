import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectTestCommand, parseCounts, runTestCommand } from '@/engine/test-runner'

const tmp = () => mkdtempSync(join(tmpdir(), 'factory-tests-'))

test('reads vitest and jest summaries, and nothing else', () => {
  expect(parseCounts(' Test Files  2 passed (2)\n      Tests  3 passed | 1 failed (4)\n')).toEqual({ passed: 3, failed: 1, total: 4 })
  expect(parseCounts('      Tests  4 passed (4)')).toEqual({ passed: 4, failed: 0, total: 4 })
  expect(parseCounts('      Tests  2 failed | 5 passed (7)')).toEqual({ passed: 5, failed: 2, total: 7 })
  expect(parseCounts('Tests:       1 failed, 3 passed, 4 total')).toEqual({ passed: 3, failed: 1, total: 4 })
  expect(parseCounts('Tests:       3 passed, 3 total')).toEqual({ passed: 3, failed: 0, total: 3 })
  // node's built-in runner (node --test) ends with a TAP-style tally.
  expect(parseCounts('# tests 4\n# suites 0\n# pass 3\n# fail 1\n# cancelled 0\n')).toEqual({ passed: 3, failed: 1, total: 4 })
  expect(parseCounts('ℹ tests 2\nℹ pass 2\nℹ fail 0\n')).toEqual({ passed: 2, failed: 0, total: 2 })
  expect(parseCounts('ok all good')).toBeNull()
  expect(parseCounts('')).toBeNull()
})

test('a failing command records its exit code and no invented counts', async () => {
  const run = await runTestCommand('echo nothing to see; exit 3', tmp(), new AbortController().signal)
  expect(run.exitCode).toBe(3)
  expect(run.counts).toBeNull()
  expect(run.outputTail).toContain('nothing to see')
  expect(run.durationMs).toBeGreaterThanOrEqual(0)
  expect(run.command).toBe('echo nothing to see; exit 3')
})

test('a passing command with a summary records the counts it printed', async () => {
  const run = await runTestCommand("printf '      Tests  4 passed (4)\\n'", tmp(), new AbortController().signal)
  expect(run.exitCode).toBe(0)
  expect(run.counts).toEqual({ passed: 4, failed: 0, total: 4 })
})

test('the output tail is bounded and redacted', async () => {
  const run = await runTestCommand(
    "node -e \"process.stdout.write('x'.repeat(9000)); console.log(' ghp_abcdefghijklmnopqrstuvwxyz0123456789')\"",
    tmp(),
    new AbortController().signal,
  )
  expect(run.outputTail.length).toBeLessThanOrEqual(4000)
  expect(run.outputTail).toContain('[redacted]')
  expect(run.outputTail).not.toContain('ghp_')
})

test('aborting stops the command and records no exit code', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = runTestCommand('sleep 20', tmp(), controller.signal)
  setTimeout(() => controller.abort(), 100)
  const run = await pending
  expect(run.exitCode).toBeNull()
  expect(Date.now() - started).toBeLessThan(5000)
})

test('the test command is detected from package.json, never from npm\'s placeholder', () => {
  const withTests = tmp()
  writeFileSync(join(withTests, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
  expect(detectTestCommand(withTests)).toBe('npm test')

  const placeholder = tmp()
  writeFileSync(join(placeholder, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
  expect(detectTestCommand(placeholder)).toBeNull()

  expect(detectTestCommand(tmp())).toBeNull()
  const broken = tmp()
  writeFileSync(join(broken, 'package.json'), '{ not json')
  expect(detectTestCommand(broken)).toBeNull()
})

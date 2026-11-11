import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changedTestFiles, detectTestCommand, isTestDefinition, parseCounts, runTestCommand } from '@/engine/test-runner'

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

test('colour codes in the output do not hide the counts', () => {
  // Exactly what vitest printed in a real run, colour codes and all, despite FORCE_COLOR=0.
  const output =
    '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m18 passed\x1b[39m\x1b[22m\x1b[90m (18)\x1b[39m\n' +
    '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m118 passed\x1b[39m\x1b[22m\x1b[90m (118)\x1b[39m\n'
  expect(parseCounts(output)).toEqual({ passed: 118, failed: 0, total: 118 })
})

test('a workspace run prints one summary per package, and every one of them is counted', () => {
  // pnpm -r run test across four packages: three vitest summaries and one node --test tally.
  const output = [
    'apps/desktop test:       Tests  12 passed (12)',
    'apps/mobile test:       Tests  7 passed | 1 failed (8)',
    'apps/site test: ℹ tests 3', 'apps/site test: ℹ pass 3', 'apps/site test: ℹ fail 0',
    'packages/shared test:       Tests  20 passed (20)',
  ].join('\n')
  expect(parseCounts(output)).toEqual({ passed: 42, failed: 1, total: 43 })
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

test('a command killed by a signal records the signal, so it can be reported as a measured failure', async () => {
  const run = await runTestCommand('echo started; kill -9 $$', tmp(), new AbortController().signal)
  expect(run.exitCode).toBeNull()
  expect(run.signal).toBe('SIGKILL')
  expect(run.started).toBe(true)
  expect(run.outputTail).toContain('started')
})

test('aborting stops the command and records no exit code', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = runTestCommand('sleep 20', tmp(), controller.signal)
  setTimeout(() => controller.abort(), 100)
  const run = await pending
  expect(run.exitCode).toBeNull()
  expect(run.signal).toBeNull() // the runner's own kill is a cancellation, not something the tests did
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
  // The package manager is read from the lockfile, so the command matches how the project installs.
  for (const [lock, command] of [['pnpm-lock.yaml', 'pnpm test'], ['yarn.lock', 'yarn test'], ['bun.lockb', 'bun run test'], ['bun.lock', 'bun run test'], ['package-lock.json', 'npm test']]) {
    const dir = tmp()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    writeFileSync(join(dir, lock!), '')
    expect(detectTestCommand(dir)).toBe(command)
  }
  const broken = tmp()
  writeFileSync(join(broken, 'package.json'), '{ not json')
  expect(detectTestCommand(broken)).toBeNull()
})

test('what counts as a test definition: tests, the command that runs them, and the runner\'s configuration', () => {
  for (const p of ['package.json', 'apps/web/package.json', 'test/cart.test.js', 'src/__tests__/a.ts', 'src/a.spec.tsx',
    'vitest.config.ts', 'jest.config.mjs', '.mocharc.json', 'tests/conftest.py', 'pkg/a_test.go', 'test_api.py', 'Makefile']) {
    expect(isTestDefinition(p)).toBe(true)
  }
  for (const p of ['src/cart.js', 'README.md', 'src/testing-utils.ts', 'src/latest.ts', 'contest.py']) expect(isTestDefinition(p)).toBe(false)
})

test('changed test files are listed against the base commit, committed, edited or new', () => {
  const dir = tmp()
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}')
  writeFileSync(join(dir, 'cart.js'), 'x')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  expect(changedTestFiles(dir, base)).toEqual([])

  writeFileSync(join(dir, 'cart.js'), 'fixed') // the code itself: not a test definition
  expect(changedTestFiles(dir, base)).toEqual([])
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"echo Tests 5 passed (5)"}}') // the gaming case
  writeFileSync(join(dir, 'new.test.js'), 'new') // an untracked new test
  expect(changedTestFiles(dir, base)).toEqual(['new.test.js', 'package.json'])
  git('add', '.')
  git('commit', '-q', '-m', 'agent committed anyway')
  expect(changedTestFiles(dir, base)).toEqual(['new.test.js', 'package.json'])
})

test('without a base commit, or outside a repository, the check reports that it could not tell', () => {
  expect(changedTestFiles(tmp(), undefined)).toBeNull()
  expect(changedTestFiles(tmp(), 'abc123')).toBeNull()
})

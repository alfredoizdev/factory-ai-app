import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { claudeArgs, createClaudeProvider, routeFor, STOP_GRACE_MS } from '@/providers/claude'
import type { AgentEvent } from '@/providers/types'
import type { TestRun } from '@/engine/test-runner'
import { strings } from '@/ui/strings'

type Fake = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; exitCode: number | null; signalCode: null }

function fakeChild(): Fake {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    exitCode: null as number | null,
    signalCode: null,
  })
  child.kill.mockImplementation(() => {
    child.stdout.end()
    child.exitCode = 143
    queueMicrotask(() => child.emit('close', null))
    return true
  })
  return child
}

function finish(child: Fake, lines: unknown[], code = 0, stderr = '') {
  for (const l of lines) child.stdout.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`)
  if (stderr) child.stderr.write(stderr)
  child.stdout.end()
  child.exitCode = code
  setTimeout(() => child.emit('close', code), 5)
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const signal = () => new AbortController().signal
const build = { blockKind: 'build' as const, request: 'make it blue', workdir: '/wt' }

test('the builder is started with the agreed arguments, in the worktree, with the prompt as an argument', async () => {
  const child = fakeChild()
  const spawn = vi.fn(() => child)
  const provider = createClaudeProvider({ spawn: spawn as never })
  const pending = collect(provider.execute(build, { signal: signal() }))
  finish(child, [{ type: 'result', is_error: false, result: 'Done.', usage: { input_tokens: 1, output_tokens: 2 } }])
  await pending
  const [bin, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string; stdio: unknown[] }]
  expect(bin).toBe('claude')
  expect(args).toEqual(claudeArgs(strings.providers.claude.buildPrompt('make it blue')))
  expect(args.slice(2)).toEqual(['--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'])
  expect(opts.cwd).toBe('/wt')
  expect(opts.stdio[0]).toBe('ignore')
})

test('tool calls stream out as steps and the result ends the stream', async () => {
  const child = fakeChild()
  const provider = createClaudeProvider({ spawn: (() => child) as never })
  const pending = collect(provider.execute(build, { signal: signal() }))
  finish(child, [
    { type: 'system', subtype: 'init' },
    'garbage that is not json',
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/wt/a.ts' } }] } },
    { type: 'result', is_error: false, result: 'Changed a.ts.' },
  ])
  expect(await pending).toEqual([
    { type: 'step', text: 'Editing a.ts' },
    { type: 'done', summary: 'Changed a.ts.', source: 'provider', usage: { tokens: null } },
  ])
})

test('an exit with no result is an error that carries the redacted end of stderr', async () => {
  const child = fakeChild()
  const provider = createClaudeProvider({ spawn: (() => child) as never })
  const pending = collect(provider.execute(build, { signal: signal() }))
  finish(child, [], 1, 'boom: token ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  const events = await pending
  expect(events).toHaveLength(1)
  expect(events[0]!.type).toBe('error')
  expect((events[0] as { source?: string }).source).toBe('system') // the app's sentence, not the model's words
  const message = (events[0] as { message: string }).message
  expect(message).toContain('code 1')
  expect(message).toContain('boom')
  expect(message).not.toContain('ghp_')
})

test('a missing claude command says so in plain words', async () => {
  const child = fakeChild()
  const provider = createClaudeProvider({ spawn: (() => child) as never })
  const pending = collect(provider.execute(build, { signal: signal() }))
  child.stdout.end()
  setTimeout(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })), 5)
  expect(await pending).toEqual([{ type: 'error', source: 'system', message: strings.providers.claude.notFound }])
})

test('no worktree means the agent is never started', async () => {
  const spawn = vi.fn()
  const provider = createClaudeProvider({ spawn: spawn as never })
  expect(await collect(provider.execute({ ...build, workdir: undefined }, { signal: signal() }))).toEqual([
    { type: 'error', source: 'system', message: strings.providers.claude.noWorkdir },
  ])
  expect(spawn).not.toHaveBeenCalled()
})

test('the builder starts in its own process group', async () => {
  const child = fakeChild()
  const spawn = vi.fn(() => child)
  const pending = collect(createClaudeProvider({ spawn: spawn as never }).execute(build, { signal: signal() }))
  finish(child, [{ type: 'result', is_error: false, result: 'ok' }])
  await pending
  expect((spawn.mock.calls[0] as unknown as [string, string[], { detached: boolean }])[2].detached).toBe(true)
})

test('cancelling signals the whole process group, then kills whatever is left after the grace period', async () => {
  vi.useFakeTimers()
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  try {
    const child = Object.assign(fakeChild(), { pid: 4242 })
    const controller = new AbortController()
    const pending = collect(createClaudeProvider({ spawn: (() => child) as never }).execute(build, { signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(-4242, 'SIGKILL')
    child.stdout.end()
    child.emit('close', null)
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS)
    await pending
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
  } finally {
    kill.mockRestore()
    vi.useRealTimers()
  }
})

test('cancelling stops the builder process', async () => {
  const child = fakeChild()
  const provider = createClaudeProvider({ spawn: (() => child) as never })
  const controller = new AbortController()
  const pending = collect(provider.execute(build, { signal: controller.signal }))
  child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/wt/x' } }] } })}\n`)
  await new Promise(r => setTimeout(r, 10))
  controller.abort()
  const events = await pending
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(events.every(e => e.type === 'step')).toBe(true) // nothing terminal is invented after a cancel
})

const testRun = (over: Partial<TestRun>): TestRun => ({
  command: 'npm test', exitCode: 0, signal: null, started: true, durationMs: 50, counts: null, outputTail: '', changedTestFiles: [], ...over,
})

test('tests run the configured command and report evidence, then a sentence the app wrote', async () => {
  const runTests = vi.fn(async () => testRun({ counts: { passed: 4, failed: 0, total: 4 } }))
  const provider = createClaudeProvider({ runTests })
  const events = await collect(provider.execute({ blockKind: 'tests', request: 'r', workdir: '/wt', testCommand: 'npm test' }, { signal: signal() }))
  expect(runTests).toHaveBeenCalledWith('npm test', '/wt', expect.anything())
  expect(events.map(e => e.type)).toEqual(['step', 'evidence', 'done'])
  expect(events[2]).toEqual({ type: 'done', source: 'system', summary: strings.summary.testsPassed(4, 4) })
})

test('failing tests are a system-written failure that must not be retried, and counts are never invented', async () => {
  const provider = createClaudeProvider({ runTests: async () => testRun({ exitCode: 1, counts: null }) })
  const events = await collect(provider.execute({ blockKind: 'tests', request: 'r', workdir: '/wt', testCommand: 'npm test' }, { signal: signal() }))
  expect(events.at(-1)).toEqual({ type: 'error', source: 'system', cause: 'tests_failed', message: strings.summary.failedWithoutCounts })
})

test('the input block records the request without calling any agent', async () => {
  const spawn = vi.fn()
  const events = await collect(createClaudeProvider({ spawn: spawn as never }).execute({ blockKind: 'input', request: 'r' }, { signal: signal() }))
  expect(events.at(-1)).toEqual({ type: 'done', source: 'system', summary: strings.summary.input.passed })
  expect(spawn).not.toHaveBeenCalled()
})

test('blocks the real agent does not do yet are skipped with a reason, never faked', () => {
  expect(routeFor('plan', {})).toEqual({ mode: 'skip', reason: strings.run.notYet.plan })
  expect(routeFor('review', {})).toEqual({ mode: 'skip', reason: strings.run.notYet.review })
  expect(routeFor('approve', {})).toEqual({ mode: 'skip', reason: strings.run.notYet.review })
  expect(routeFor('ship', {})).toEqual({ mode: 'skip', reason: strings.run.notYet.ship })
  expect(routeFor('tests', { testCommand: null })).toEqual({ mode: 'skip', reason: strings.run.notYet.noTestCommand })
  expect(routeFor('tests', { testCommand: '  ' })).toEqual({ mode: 'skip', reason: strings.run.notYet.noTestCommand })
  expect(routeFor('tests', { testCommand: 'npm test' })).toEqual({ mode: 'execute' })
  expect(routeFor('build', {})).toEqual({ mode: 'execute' })
  expect(routeFor('input', {})).toEqual({ mode: 'execute' })
})

test('tests killed by a signal are recorded as evidence and as a failure that is not retried', async () => {
  const provider = createClaudeProvider({ runTests: async () => testRun({ exitCode: null, signal: 'SIGKILL' }) })
  const events = await collect(provider.execute({ blockKind: 'tests', request: 'r', workdir: '/wt', testCommand: 'npm test' }, { signal: signal() }))
  expect(events.map(e => e.type)).toEqual(['step', 'evidence', 'error'])
  expect(events.at(-1)).toEqual({ type: 'error', source: 'system', cause: 'tests_failed', message: strings.run.testsKilled('SIGKILL') })
})

test('a test command that could not start leaves no evidence, says so, and is not retried', async () => {
  const provider = createClaudeProvider({ runTests: async () => testRun({ exitCode: null, started: false }) })
  const events = await collect(provider.execute({ blockKind: 'tests', request: 'r', workdir: '/wt', testCommand: 'npm test' }, { signal: signal() }))
  expect(events.map(e => e.type)).toEqual(['step', 'error'])
  expect(events.at(-1)).toEqual({ type: 'error', source: 'system', cause: 'tests_failed', message: strings.run.testsDidNotStart('npm test') })
})

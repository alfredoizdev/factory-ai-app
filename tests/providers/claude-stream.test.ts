import { mapStreamLine, toolStep } from '@/providers/claude-stream'

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } })
const tool = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', name, input })
const WT = '/work/tree'

test('each kind of tool call becomes a plain sentence about what the agent is doing', () => {
  expect(toolStep('Edit', { file_path: `${WT}/src/Button.tsx` }, WT)).toBe('Editing src/Button.tsx')
  expect(toolStep('MultiEdit', { file_path: `${WT}/a.ts` }, WT)).toBe('Editing a.ts')
  expect(toolStep('Write', { file_path: `${WT}/new.ts` }, WT)).toBe('Writing new.ts')
  expect(toolStep('Read', { file_path: `${WT}/README.md` }, WT)).toBe('Reading README.md')
  expect(toolStep('Bash', { command: 'npm test -- --run' }, WT)).toBe('Running: npm test -- --run')
  expect(toolStep('Grep', { pattern: 'x' }, WT)).toBe('Searching the code')
  expect(toolStep('Glob', { pattern: '**/*.ts' }, WT)).toBe('Searching the code')
  expect(toolStep('TodoWrite', {}, WT)).toBe('Updating its task list')
  expect(toolStep('mcp__thing__do', {}, WT)).toBe('Using mcp__thing__do')
})

test('a path outside the worktree is shown in full, so a stray edit is visible', () => {
  expect(toolStep('Edit', { file_path: '/etc/hosts' }, WT)).toBe('Editing /etc/hosts')
})

test('a command is redacted and clipped before it becomes a step', () => {
  const step = toolStep('Bash', { command: `curl -H "Authorization: Bearer abcdefghijkl123" ${'x'.repeat(300)}` }, WT)
  expect(step).toContain('[redacted]')
  expect(step).not.toContain('abcdefghijkl123')
  expect(step.length).toBeLessThanOrEqual(130)
})

test('an assistant message yields one step per tool call and ignores prose', () => {
  const line = assistant({ type: 'text', text: 'I will look.' }, tool('Read', { file_path: `${WT}/a.ts` }), tool('Edit', { file_path: `${WT}/a.ts` }))
  expect(mapStreamLine(line, WT)).toEqual([
    { type: 'step', text: 'Reading a.ts' },
    { type: 'step', text: 'Editing a.ts' },
  ])
})

test('a successful result ends the stream with the model\'s sentence as a claim and the tokens it reported', () => {
  const line = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Made the button blue.',
    total_cost_usd: 0.42,
    usage: { input_tokens: 4, output_tokens: 131, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
  }
  expect(mapStreamLine(line, WT)).toEqual([
    { type: 'done', summary: 'Made the button blue.', fullText: 'Made the button blue.', source: 'provider', usage: { tokens: 1235 } },
  ])
})

test('a result with no usage reports tokens as unknown, not zero, and the dollar estimate is never carried', () => {
  const [ev] = mapStreamLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 1 }, WT)
  expect(ev).toEqual({ type: 'done', summary: 'ok', fullText: 'ok', source: 'provider', usage: { tokens: null } })
  expect(JSON.stringify(ev)).not.toContain('cost')
})

test('a failed result becomes an error, redacted', () => {
  const [ev] = mapStreamLine({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'gave up, token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, WT)
  expect(ev!.type).toBe('error')
  expect((ev as { message: string }).message).toContain('[redacted]')
})

test('a failed result with the model\'s words is the model\'s; without them the app writes the sentence', () => {
  expect(mapStreamLine({ type: 'result', is_error: true, result: 'I could not do it.' }, WT)).toEqual([
    { type: 'error', source: 'provider', message: 'I could not do it.' },
  ])
  expect(mapStreamLine({ type: 'result', is_error: true, subtype: 'error_max_turns' }, WT)).toEqual([
    { type: 'error', source: 'system', message: 'The agent stopped: error_max_turns.' },
  ])
  expect(mapStreamLine({ type: 'result', is_error: false, result: '' }, WT)[0]!.type).toBe('done')
})

test('system lines, hook output, tool results and anything unknown yield nothing', () => {
  expect(mapStreamLine({ type: 'system', subtype: 'init' }, WT)).toEqual([])
  expect(mapStreamLine({ type: 'system', subtype: 'hook_response', output: 'secret stuff' }, WT)).toEqual([])
  expect(mapStreamLine({ type: 'user', message: { content: [{ type: 'tool_result' }] } }, WT)).toEqual([])
  expect(mapStreamLine({ type: 'rate_limit_event' }, WT)).toEqual([])
  expect(mapStreamLine(null, WT)).toEqual([])
  expect(mapStreamLine('not json', WT)).toEqual([])
  expect(mapStreamLine({ type: 'assistant', message: { content: 'oops' } }, WT)).toEqual([])
})

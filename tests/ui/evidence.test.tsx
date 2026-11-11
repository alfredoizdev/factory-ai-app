// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { defaultGraph } from '@/domain/graph'
import { BlockCard } from '@/ui/canvas/BlockCard'
import { emptyStream, foldEvent, toViews, type Wire } from '@/ui/canvas/useRunStream'
import { strings } from '@/ui/strings'

const blocks = defaultGraph().blocks
const tests = blocks.find(b => b.id === 'tests')!
const build = blocks.find(b => b.id === 'build')!

function fold(events: Omit<Wire, 'sequence'>[]) {
  return toViews(events.reduce((s, e, i) => foldEvent(s, { ...e, sequence: i + 1 }), emptyStream).nodes, blocks)
}

const failedTests = [
  { type: 'node.started' as const, payload: { blockId: 'tests' } },
  { type: 'node.evidence' as const, payload: { blockId: 'tests', kind: 'test_run', exitCode: 1, signal: null, durationMs: 2300, counts: { passed: 3, failed: 1, total: 4 }, changedTestFiles: [], changedTestFilesCount: 0 } },
  { type: 'node.failed' as const, payload: { blockId: 'tests', cause: 'tests_failed', message: 'x', messageSource: 'system' } },
]

test('measured counts become the card\'s sentence, and it is not a claim', () => {
  const view = fold(failedTests).tests!
  expect(view.summary).toBe(strings.summary.testsFailed(3, 1, 4))
  expect(view.summaryIsClaim).toBe(false)
  expect(view.evidence).toEqual({
    counts: { passed: 3, failed: 1, total: 4 }, exitCode: 1, signal: null, durationMs: 2300, changedTestFiles: [], changedTestFilesCount: 0,
  })
})

test('the evidence strip shows a pip per test, the exit code and how long it took', () => {
  render(<BlockCard block={tests} view={fold(failedTests).tests!} />)
  const strip = screen.getByTestId('evidence-strip')
  const pips = strip.querySelectorAll('[data-pip]')
  expect([...pips].map(p => p.getAttribute('data-pip'))).toEqual(['passed', 'passed', 'passed', 'failed'])
  expect(within(strip).getByRole('img')).toHaveAccessibleName(strings.canvas.evidenceCounts(3, 1, 4))
  expect(within(strip).getByText('1')).toBeInTheDocument()
  expect(within(strip).getByText('2.3s')).toBeInTheDocument()
  expect(screen.queryByText(/AI says/i)).toBeNull()
})

test('evidence without counts shows the exit code and invents no pips', () => {
  const view = fold([
    { type: 'node.started', payload: { blockId: 'tests' } },
    { type: 'node.evidence', payload: { blockId: 'tests', kind: 'test_run', exitCode: 2, durationMs: 40, counts: null } },
  ]).tests!
  render(<BlockCard block={tests} view={view} />)
  const strip = screen.getByTestId('evidence-strip')
  expect(strip.querySelectorAll('[data-pip]')).toHaveLength(0)
  expect(within(strip).getByText('2')).toBeInTheDocument()
})

test('malformed evidence is dropped rather than drawn with invented parts', () => {
  const view = fold([
    { type: 'node.started', payload: { blockId: 'tests' } },
    { type: 'node.evidence', payload: { blockId: 'tests', exitCode: 0, durationMs: 'soon', counts: { passed: 9, failed: 0, total: 4 } } },
  ]).tests!
  expect(view.evidence).toBeUndefined()
})

test('a card whose result is only a model\'s sentence has no evidence strip', () => {
  const view = fold([
    { type: 'node.started', payload: { blockId: 'build' } },
    { type: 'node.completed', payload: { blockId: 'build', summary: 'Made it blue.', summarySource: 'provider', tokens: 1200 } },
  ]).build!
  render(<BlockCard block={build} view={view} />)
  expect(screen.queryByTestId('evidence-strip')).toBeNull()
  expect(screen.getByText(/AI says/i)).toBeInTheDocument()
})

test('a real build shows the tokens it reported and says its cost was not reported', () => {
  const view = fold([
    { type: 'node.started', payload: { blockId: 'build' } },
    { type: 'node.completed', payload: { blockId: 'build', summary: 'ok', summarySource: 'provider', tokens: 1200 } },
  ]).build!
  expect(view.usage).toEqual({ tokens: 1200, costCents: null })
  render(<BlockCard block={build} view={view} />)
  expect(screen.getByText('1,200')).toBeInTheDocument()
  expect(screen.getByText(strings.canvas.notReported)).toBeInTheDocument()
  expect(screen.queryByText('$0.00')).toBeNull()
})

test('a demo build that reports nothing about usage shows no usage row', () => {
  const view = fold([
    { type: 'node.started', payload: { blockId: 'build' } },
    { type: 'node.completed', payload: { blockId: 'build', summary: 'ok', summarySource: 'provider' } },
  ]).build!
  expect(view.usage).toBeUndefined()
})

test('the event bar describes a measurement in words, and never as a claim', async () => {
  const { describeEvent } = await import('@/ui/EventBar')
  const line = describeEvent({ sequence: 1, type: 'node.evidence', payload: failedTests[1]!.payload }, tests)
  expect(line).toEqual({ text: 'Tests measured: 3 of 4 passed, 1 failed. Exit code 1.', isClaim: false })
  const bare = describeEvent({ sequence: 2, type: 'node.evidence', payload: { blockId: 'tests', durationMs: 5, exitCode: 2, counts: null } }, tests)
  expect(bare.text).toBe('Tests measured. Exit code 2.')
})

const evidenceView = (extra: Record<string, unknown>) =>
  fold([
    { type: 'node.started', payload: { blockId: 'tests' } },
    { type: 'node.evidence', payload: { blockId: 'tests', kind: 'test_run', exitCode: 0, durationMs: 90, counts: { passed: 5, failed: 0, total: 5 }, ...extra } },
    { type: 'node.completed', payload: { blockId: 'tests', summary: 'x', summarySource: 'system' } },
  ]).tests!

test('a run that changed its own tests says so on the strip, names the files, and loses the check mark', () => {
  render(<BlockCard block={tests} view={evidenceView({ changedTestFiles: ['package.json', 'test/a.test.js'], changedTestFilesCount: 2 })} />)
  const strip = screen.getByTestId('evidence-strip')
  expect(within(strip).getByTestId('tests-changed')).toHaveTextContent(strings.canvas.testsChanged(2))
  expect(within(strip).getByTestId('tests-changed')).toHaveTextContent('package.json, test/a.test.js')
  expect(within(strip).queryByText('✓')).toBeNull()
})

test('more changed files than fit are counted, not dropped', () => {
  render(<BlockCard block={tests} view={evidenceView({ changedTestFiles: ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js'], changedTestFilesCount: 25 })} />)
  expect(screen.getByTestId('tests-changed')).toHaveTextContent(strings.canvas.andMore(22))
})

test('a run that left its tests alone keeps the check mark', () => {
  render(<BlockCard block={tests} view={evidenceView({ changedTestFiles: [], changedTestFilesCount: 0 })} />)
  expect(within(screen.getByTestId('evidence-strip')).getByText('✓')).toBeInTheDocument()
  expect(screen.queryByTestId('tests-changed')).toBeNull()
})

test('when it could not be checked, the strip says so instead of implying the tests were untouched', () => {
  render(<BlockCard block={tests} view={evidenceView({ changedTestFiles: null })} />)
  expect(screen.getByTestId('tests-unchecked')).toBeInTheDocument()
  expect(within(screen.getByTestId('evidence-strip')).queryByText('✓')).toBeNull()
})

test('tests killed by a signal show the signal where the exit code would be', () => {
  render(<BlockCard block={tests} view={evidenceView({ exitCode: null, signal: 'SIGKILL', changedTestFiles: [] })} />)
  expect(within(screen.getByTestId('evidence-strip')).getByText('SIGKILL')).toBeInTheDocument()
})

const human = blocks.find(b => b.id === 'human')!
const assessedView = (payload: Record<string, unknown>, ending: Omit<Wire, 'sequence'>) =>
  fold([
    { type: 'node.queued', payload: { blockId: 'human' } },
    { type: 'node.assessed', payload: { blockId: 'human', ...payload } },
    { type: 'node.started', payload: { blockId: 'human' } }, // as the executor sends it: queued, then running, then the end
    ending,
  ]).human!

test('a change measured as low risk says so, and why, on the human check', () => {
  const view = assessedView(
    { level: 'low', reasons: ['1 file, 2 lines, nothing sensitive, tests passed and untouched.'] },
    { type: 'node.completed', payload: { blockId: 'human', summary: strings.risk.passedLow, summarySource: 'system' } },
  )
  render(<BlockCard block={human} view={view} />)
  expect(screen.getByTestId('risk-strip')).toHaveAttribute('data-level', 'low')
  expect(screen.getByTestId('risk-strip')).toHaveTextContent(strings.risk.label.low)
  expect(screen.getByText(strings.risk.passedLow)).toBeInTheDocument()
  expect(screen.queryByText(/AI says/i)).toBeNull()
})

test('a change that needs the person lists what was found', () => {
  const view = assessedView(
    { level: 'high', reasons: ['It changes src/lib/stripe.ts (payments).'] },
    { type: 'node.waiting_approval', payload: { blockId: 'human' } },
  )
  render(<BlockCard block={human} view={view} />)
  expect(screen.getByTestId('risk-strip')).toHaveAttribute('data-level', 'high')
  expect(screen.getByText('It changes src/lib/stripe.ts (payments).')).toBeInTheDocument()
})

test('a malformed assessment draws nothing', () => {
  const view = assessedView({ level: 'medium', reasons: ['x'] }, { type: 'node.waiting_approval', payload: { blockId: 'human' } })
  expect(view.risk).toBeUndefined()
})

test('the event bar reads the assessment in words', async () => {
  const { describeEvent } = await import('@/ui/EventBar')
  const line = describeEvent({ sequence: 1, type: 'node.assessed', payload: { blockId: 'human', level: 'high', reasons: ['It changes package.json (dependencies and configuration).'] } }, human)
  expect(line).toEqual({ text: 'Needs you: It changes package.json (dependencies and configuration).', isClaim: false })
})

test('a block sent back for another round starts over, says which round, and keeps nothing from the last one', () => {
  const view = fold([
    { type: 'node.started', payload: { blockId: 'tests' } },
    { type: 'node.step', payload: { blockId: 'tests', text: 'old step' } },
    { type: 'node.evidence', payload: { blockId: 'tests', kind: 'test_run', exitCode: 0, durationMs: 5, counts: { passed: 1, failed: 0, total: 1 }, changedTestFiles: [] } },
    { type: 'node.completed', payload: { blockId: 'tests', summary: 'x', summarySource: 'system' } },
    { type: 'node.reopened', payload: { blockId: 'tests', round: 2, note: 'thicker' } },
  ]).tests!
  expect(view.state).toBe('queued')
  expect(view.steps).toEqual([])
  expect(view.evidence).toBeUndefined()
  expect(view.round).toBe(2)
  render(<BlockCard block={tests} view={view} />)
  expect(screen.getByTestId('round-tests')).toHaveTextContent(strings.gate.round(2))
})

test('the event bar shows the person\'s note when work is sent back', async () => {
  const { describeEvent } = await import('@/ui/EventBar')
  expect(describeEvent({ sequence: 1, type: 'node.reopened', payload: { blockId: 'tests', round: 2, note: 'thicker' } }, tests)).toEqual({
    text: 'Sent back for round 2: thicker',
    isClaim: false,
  })
})

test('a failed command whose counted tests all passed does not read as a pass', () => {
  expect(strings.summary.testsFailed(77, 0, 77)).toMatch(/failed, although the 77 tests it counted passed/)
  expect(strings.summary.testsFailed(77, 0, 77)).not.toMatch(/0 failed/)
})

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
  { type: 'node.evidence' as const, payload: { blockId: 'tests', kind: 'test_run', exitCode: 1, durationMs: 2300, counts: { passed: 3, failed: 1, total: 4 } } },
  { type: 'node.failed' as const, payload: { blockId: 'tests', cause: 'tests_failed', message: 'x', messageSource: 'system' } },
]

test('measured counts become the card\'s sentence, and it is not a claim', () => {
  const view = fold(failedTests).tests!
  expect(view.summary).toBe(strings.summary.testsFailed(3, 1, 4))
  expect(view.summaryIsClaim).toBe(false)
  expect(view.evidence).toEqual({ counts: { passed: 3, failed: 1, total: 4 }, exitCode: 1, durationMs: 2300 })
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

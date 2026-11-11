// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { defaultGraph, type Block, type Graph } from '@/domain/graph'
import { CanvasScreen } from '@/ui/canvas/CanvasScreen'
import { addBlock } from '@/ui/canvas/editing'
import { strings } from '@/ui/strings'

// While a run is watched, what a block is (its name, whether it took part, its model) comes from the run's frozen
// blocks. The draft only decides where it sits and what can be edited.

class FakeEventSource {
  static all: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeEventSource.all.push(this)
  }
  close() {}
}
let seq = 0
async function emit(type: string, payload: Record<string, unknown> = {}) {
  const es = FakeEventSource.all.at(-1)!
  seq++
  await act(async () => {
    es.onmessage?.({ data: JSON.stringify({ id: `e${seq}`, runId: 'r1', nodeRunId: null, sequence: seq, type, payload, createdAt: '' }) })
  })
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
beforeEach(() => {
  seq = 0
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

const base = defaultGraph()
const runOf = (blocks: Block[]) => ({ runId: 'r1', providerId: 'other-provider', blocks })
const page = (draft: Graph, run: Block[]) => render(<CanvasScreen workflowId="w1" graph={draft} run={runOf(run)} />)
const node = (id: string) => screen.getByTestId(`node-${id}`)
const edges = () => (screen.getByTestId('canvas').getAttribute('data-edges') ?? '').split(',').filter(Boolean)

test('removing a block from the draft while it runs leaves its card, so "Point it out" still points at something', async () => {
  const withReview = addBlock(base, 'review') // review and review-1; both removable
  page(withReview, withReview.blocks)
  await emit('node.started', { blockId: 'review-1' })
  await emit('node.step', { blockId: 'review-1', text: 'reading' })

  fireEvent.click(within(node('review-1')).getByText(strings.blocks.review))
  fireEvent.click(screen.getByRole('button', { name: strings.editing.remove }))

  // The draft no longer has it, the run does: the card stays, still showing the run's state.
  expect(node('review-1')).toHaveAttribute('data-state', 'running')
  expect(node('review-1')).toHaveAttribute('data-highlighted', 'false')
  const bar = screen.getByTestId('event-bar')
  const buttons = within(bar).getAllByRole('button', { name: /point it out/i })
  expect(buttons.length).toBeGreaterThan(0)
  fireEvent.click(buttons[0]!)
  expect(node('review-1')).toHaveAttribute('data-highlighted', 'true')
})

test('every line in the event bar points at a card that exists, even after edits', async () => {
  const withReview = addBlock(base, 'review')
  page(withReview, withReview.blocks)
  await emit('node.started', { blockId: 'review-1' })
  fireEvent.click(within(node('review-1')).getByText(strings.blocks.review))
  fireEvent.click(screen.getByRole('button', { name: strings.editing.remove }))
  for (const line of within(screen.getByTestId('event-bar')).getAllByTestId('event-line')) {
    expect(line).toBeInTheDocument()
  }
  // The block of each line is a drawn node.
  expect(screen.queryByTestId('node-review-1')).not.toBeNull()
})

test('turning a block off after it ran does not rewrite what the run did', async () => {
  page(base, base.blocks)
  await emit('node.started', { blockId: 'tests' })
  await emit('node.completed', { blockId: 'tests', summary: 'ok', summarySource: 'system' })
  expect(node('tests')).toHaveAttribute('data-state', 'passed')
  const before = edges()
  expect(before.some(e => e.includes('tests'))).toBe(true)

  fireEvent.click(within(node('tests')).getByText(strings.blocks.tests))
  fireEvent.click(screen.getByLabelText(strings.editing.enabled))

  const card = screen.getByTestId('block-card-tests')
  expect(node('tests')).toHaveAttribute('data-state', 'passed')
  expect(within(card).getByText(strings.canvas.stateLabel.passed)).toBeInTheDocument()
  expect(within(card).queryByText(strings.editing.disabledLine)).toBeNull()
  expect(within(card).queryByText(strings.editing.disabledBadge)).toBeNull()
  expect(card.style.opacity).toBe('1')
  expect(edges()).toEqual(before) // the cables the run really went through are still drawn
})

test('a block the run skipped because it was off stays shown as off', async () => {
  const off: Graph = { blocks: base.blocks.map(b => (b.kind === 'tests' ? { ...b, enabled: false } : b)) }
  page(off, off.blocks)
  await emit('node.skipped', { blockId: 'tests', reason: strings.run.skippedDisabled })
  const card = screen.getByTestId('block-card-tests')
  expect(within(card).getByText(strings.editing.disabledLine)).toBeInTheDocument()
})

test('a rename in the draft does not rename the card of the run being watched', () => {
  page(base, base.blocks)
  fireEvent.click(within(node('build')).getByText(strings.blocks.build))
  fireEvent.change(screen.getByLabelText(strings.editing.name), { target: { value: 'Renamed' } })
  expect(within(screen.getByTestId('block-card-build')).getByText(strings.blocks.build)).toBeInTheDocument()
  expect(within(screen.getByTestId('block-card-build')).queryByText('Renamed')).toBeNull()
})

test('the card shows the model the run used, not the one typed into the draft afterwards', () => {
  const run = base.blocks.map(b => (b.kind === 'build' ? { ...b, config: { model: 'run-model' } } : b))
  page({ blocks: run }, run)
  // The fisheye opens on how far the run got, so Build is opened first to read its chip.
  fireEvent.click(within(node('build')).getByText(strings.blocks.build))
  expect(screen.getByTestId('block-model-build')).toHaveTextContent('run-model')
  fireEvent.change(screen.getByLabelText(strings.editing.model), { target: { value: 'draft-model' } })
  expect(screen.getByTestId('block-model-build')).toHaveTextContent('run-model')
})

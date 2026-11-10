// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { defaultGraph, type Block, type Graph } from '@/domain/graph'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { CanvasScreen } from '@/ui/canvas/CanvasScreen'
import { addBlock, nextBlockId, removeBlock } from '@/ui/canvas/editing'
import { strings } from '@/ui/strings'

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

const graph = defaultGraph()
const runOf = (blocks: Block[], providerId = 'other-provider') => ({ runId: 'r1', providerId, blocks })
const page = (draft: Graph = graph, run = runOf(graph.blocks)) => render(<CanvasScreen workflowId="w1" graph={draft} run={run} />)
const state = (id: string) => screen.getByTestId(`node-${id}`).getAttribute('data-state')

test('a node lights up only when an event says so', async () => {
  page()
  expect(state('build')).toBe('queued')
  // Events about other blocks, and run-level events, do not move this block.
  await emit('run.started')
  await emit('node.started', { blockId: 'plan' })
  expect(state('build')).toBe('queued')
  expect(state('plan')).toBe('running')
  await emit('node.started', { blockId: 'build' })
  await waitFor(() => expect(state('build')).toBe('running'))
})

test('every event line names its block and can point at it', async () => {
  page()
  await emit('node.failed', { blockId: 'review', cause: 'x' })
  const bar = screen.getByTestId('event-bar')
  expect(within(bar).getByText('Review')).toBeInTheDocument()
  expect(screen.getByTestId('node-review')).toHaveAttribute('data-highlighted', 'false')
  fireEvent.click(within(bar).getByRole('button', { name: /point it out/i }))
  expect(screen.getByTestId('node-review')).toHaveAttribute('data-highlighted', 'true')
  expect(screen.getByTestId('node-build')).toHaveAttribute('data-highlighted', 'false')
})

test('an event for a block the run does not contain is not listed as a line', async () => {
  page()
  await emit('node.started', { blockId: 'ghost' })
  expect(within(screen.getByTestId('event-bar')).queryAllByRole('button')).toHaveLength(0)
})

test('a demo run is labelled demo, and only a demo run', () => {
  page(graph, runOf(graph.blocks, DEMO_PROVIDER_ID))
  expect(screen.getByText(strings.run.demoBadge)).toBeInTheDocument()
})

test('a run that is not a demo run has no demo badge', () => {
  page()
  expect(screen.queryByText(strings.run.demoBadge)).toBeNull()
})

test('the run stops at the human gate and a duplicate waiting event changes nothing', async () => {
  page()
  await emit('run.started')
  await emit('node.started', { blockId: 'human' })
  await emit('run.waiting_approval', { blockId: 'human' })
  await emit('run.waiting_approval', { blockId: 'human' })
  await emit('node.waiting_approval', { blockId: 'human' })
  expect(state('human')).toBe('waiting_approval')
  expect(screen.getByTestId('run-status')).toHaveTextContent(strings.run.status.waiting_approval)
  expect(screen.getByRole('button', { name: strings.run.cancel })).toBeEnabled()
  expect(state('ship')).toBe('queued')
})

test('Cancel is only offered while the run is live', async () => {
  page()
  expect(screen.getByRole('button', { name: strings.run.cancel })).toBeDisabled()
  await emit('run.started')
  expect(screen.getByRole('button', { name: strings.run.cancel })).toBeEnabled()
  await emit('run.cancelled')
  expect(screen.getByRole('button', { name: strings.run.cancel })).toBeDisabled()
})

test('a block added after the run began is visibly not part of the run, and can still be selected and removed', async () => {
  const draft = addBlock(graph, 'review')
  const added = draft.blocks.find(b => !graph.blocks.some(o => o.id === b.id))!
  page(draft)
  const node = screen.getByTestId(`node-${added.id}`)
  expect(node).toHaveAttribute('data-state', 'not_in_run')
  expect(within(node).getByText(strings.canvas.notInRun)).toBeInTheDocument()
  fireEvent.click(within(node).getByText(added.label))
  fireEvent.click(screen.getByRole('button', { name: strings.editing.remove }))
  expect(screen.queryByTestId(`node-${added.id}`)).toBeNull()
})

test('a new block never takes the id of a block the run already contains', () => {
  const run = addBlock(graph, 'review') // the run holds review and review-1
  const withoutIt = removeBlock(run, 'review-1')
  expect(nextBlockId(withoutIt, 'review')).toBe('review-1') // free in the draft...
  expect(nextBlockId(withoutIt, 'review', run.blocks.map(b => b.id))).toBe('review-2') // ...but not reusable while the run holds it
})

test('a reused block id does not inherit the run view of the block it replaced', async () => {
  const runGraph = addBlock(graph, 'review')
  // The draft dropped review-1 and then added a different kind that was handed the same id.
  const draft: Graph = {
    blocks: [...graph.blocks, { id: 'review-1', kind: 'tests', label: 'Tests', enabled: true, config: {}, position: { x: 0, y: 200 } }],
  }
  page(draft, runOf(runGraph.blocks))
  await emit('node.started', { blockId: 'review-1' })
  expect(state('review-1')).toBe('not_in_run')
})

test('a step for a block the log has not started does not light it', async () => {
  page()
  await emit('node.step', { blockId: 'build', text: 'writing a file' })
  expect(state('build')).toBe('queued')
})

test('the palette wire: adding a block while a run holds review-1 never hands out review-1', () => {
  const runGraph = addBlock(graph, 'review') // the run contains review and review-1
  render(<CanvasScreen workflowId="w1" graph={graph} run={runOf(runGraph.blocks)} />) // the draft lacks review-1
  // The run holds review-1, so it is drawn from the run (a run's block is never hidden because the draft dropped it).
  expect(state('review-1')).toBe('queued')
  fireEvent.click(within(screen.getByTestId('palette')).getByRole('button', { name: strings.blocks.review }))
  expect(state('review-1')).toBe('queued') // still the run's block, not overwritten by the new one
  expect(screen.getByTestId('node-review-2')).toHaveAttribute('data-state', 'not_in_run')
})

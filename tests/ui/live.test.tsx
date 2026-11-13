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

test('New task in the top bar appears once the run is over, and clears it for a fresh one', async () => {
  page()
  await emit('run.started')
  expect(screen.queryByRole('button', { name: new RegExp(strings.delivery.newTask) })).toBeNull() // not while it works
  await emit('run.completed')
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(strings.delivery.newTask) }))
  expect(screen.queryByRole('button', { name: new RegExp(strings.delivery.newTask) })).toBeNull()
  expect(screen.getByText(strings.sidebar.runTitle)).toBeInTheDocument()
  // It says how to start the new task, and does not send them to the past ones.
  expect(screen.getByTestId('no-task')).toHaveTextContent(strings.history.newTaskTitle)
  expect(screen.queryByRole('button', { name: new RegExp(strings.history.openPast) })).toBeNull()
})

test('a hidden tab closes its stream and reopens it from where it was when shown again', async () => {
  const closed: string[] = []
  FakeEventSource.prototype.close = function (this: FakeEventSource) {
    closed.push(this.url)
  }
  page()
  await emit('run.started')
  const visibility = vi.spyOn(document, 'visibilityState', 'get')
  visibility.mockReturnValue('hidden')
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
  expect(closed.at(-1)).toContain('after=0')
  visibility.mockReturnValue('visible')
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
  expect(FakeEventSource.all.at(-1)!.url).toContain(`after=${seq}`)
  visibility.mockRestore()
  FakeEventSource.prototype.close = () => {}
})

test('a question from the review waits in the same card as the other checks, and the answer sends the card back to working', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/findings') ? new Response(JSON.stringify({ findings: [], question: null, touched: [] })) : url.endsWith('/prompts') ? new Response(JSON.stringify({ prompts: [] })) : new Response('{}', { status: 404 }))))
  page()
  await emit('run.started')
  await emit('node.started', { blockId: 'review' })
  expect(screen.getByTestId('command-card')).toHaveAttribute('data-mode', 'working')
  await emit('run.waiting_approval', { blockId: 'review' })
  await emit('node.question_asked', { blockId: 'review', questionId: 'q1', kind: 'finding' })
  expect(state('review')).toBe('waiting_approval')
  expect(screen.getByTestId('command-card')).toHaveAttribute('data-mode', 'question')
  expect(screen.getByTestId('run-status')).toHaveTextContent(strings.question.stateLabel)
  expect(screen.getByTestId('block-card-review')).toHaveTextContent(strings.question.stateLabel)
  await emit('node.question_answered', { blockId: 'review', questionId: 'q1', option: 'fix' })
  await emit('run.started', { resumed: true })
  expect(state('review')).toBe('running')
  expect(screen.getByTestId('command-card')).toHaveAttribute('data-mode', 'working')
})

test('the planner\'s question waits in the question card, not as a plan to check, and can be answered', async () => {
  const planQuestion = {
    id: 'q2', runId: 'r1', nodeRunId: 'n1', findingId: null, kind: 'plan', text: 'Which sign-in?', why: strings.plan.questionWhy, detail: null,
    options: [{ id: 'a', label: 'Use username', means: 'A new field.' }, { id: 'leave', label: strings.plan.leaveLabel, means: strings.plan.leaveMeans }],
    recommended: null, touches: [], state: 'open', answerOption: null, answerText: null, actor: null, answeredAt: null,
  }
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url =>
    url.endsWith('/findings') ? new Response(JSON.stringify({ findings: [], question: planQuestion, touched: [] })) : url.endsWith('/prompts') ? new Response(JSON.stringify({ prompts: [] })) : url.endsWith('/questions/q2') ? new Response('{}') : new Response('{}', { status: 404 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  page()
  await emit('run.started')
  await emit('node.started', { blockId: 'plan' })
  await emit('run.waiting_approval', { blockId: 'plan' })
  await emit('node.question_asked', { blockId: 'plan', questionId: 'q2', kind: 'plan' })
  expect(screen.getByTestId('command-card')).toHaveAttribute('data-mode', 'question')
  expect(await screen.findByText('Which sign-in?')).toBeInTheDocument()
  expect(screen.getByText(strings.plan.questionWhy)).toBeInTheDocument()
  expect(screen.queryByText(strings.question.position(1, 1))).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: /Use username/ }))
  fireEvent.click(screen.getByRole('button', { name: strings.question.confirm }))
  await waitFor(() => expect(fetchMock.mock.calls.some(([u, init]) => String(u).endsWith('/questions/q2') && init?.method === 'POST')).toBe(true))
})

test('the human check is still the human check', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/findings') ? new Response(JSON.stringify({ findings: [], question: null, touched: [] })) : url.endsWith('/prompts') ? new Response(JSON.stringify({ prompts: [] })) : new Response('{}', { status: 404 }))))
  page()
  await emit('run.started')
  await emit('node.started', { blockId: 'human' })
  await emit('run.waiting_approval', { blockId: 'human' })
  await emit('node.waiting_approval', { blockId: 'human' })
  expect(screen.getByTestId('command-card')).toHaveAttribute('data-mode', 'waiting')
})

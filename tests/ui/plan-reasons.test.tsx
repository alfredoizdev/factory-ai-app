// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { defaultGraph } from '@/domain/graph'
import { BlockCard } from '@/ui/canvas/BlockCard'
import { BlockDetailsDialog } from '@/ui/canvas/BlockDetails'
import { CanvasScreen } from '@/ui/canvas/CanvasScreen'
import { CommandCard } from '@/ui/canvas/CommandCard'
import type { ComposerImage } from '@/ui/canvas/Composer'
import { emptyStream, foldEvent, toViews } from '@/ui/canvas/useRunStream'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const r = strings.plan.reasons
const reasons = [r.sensitive(strings.risk.areas.auth), r.tooMany(9, 8)]

function phone(node: React.ReactNode) {
  return render(<div data-testid="phone" style={{ width: 390 }}>{node}</div>)
}
const fits = () => {
  const root = screen.getByTestId('phone')
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth)
}

function Card({ measure }: { measure?: { reasons: string[] } }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  return <CommandCard mode="plan" runId="r1" planMeasure={measure} text={text} onText={setText} images={images} onImages={setImages} onRun={() => undefined} canRun={false} onFollowUp={() => undefined} onSent={() => undefined} />
}

const plan = { plan: { jobs: [{ title: 'Add sign-in', done: ['it works'], paths: ['src/auth/login.ts'] }, { title: 'Say thanks', done: [] }], by: 'planner' } }

test('a parked plan says the first reason in one sentence above the jobs; the rest wait behind "Why it stopped for you"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(plan))))
  phone(<Card measure={{ reasons }} />)
  const why = screen.getByTestId('plan-why')
  expect(why).toHaveTextContent(reasons[0]!)
  expect(why).not.toHaveTextContent(reasons[1]!)
  await screen.findByTestId('plan-jobs')
  expect(why.compareDocumentPosition(screen.getByTestId('plan-jobs')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: strings.plan.whyStopped }))
  expect(screen.getByTestId('plan-why')).toHaveTextContent(reasons[1]!)
  fits()
})

test('with one reason there is nothing more to open', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(plan))))
  render(<Card measure={{ reasons: [reasons[0]!] }} />)
  expect(screen.queryByRole('button', { name: strings.plan.whyStopped })).toBeNull()
})

test('a job the person only re-words keeps its paths; a job they add has none', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'POST' ? new Response('{"ok":true}') : new Response(JSON.stringify(plan))))
  vi.stubGlobal('fetch', fetchMock)
  render(<Card />)
  const first = await screen.findByLabelText(strings.plan.jobLabel(1))
  fireEvent.change(first, { target: { value: 'Add the sign-in page' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.plan.addJob) }))
  fireEvent.change(screen.getByLabelText(strings.plan.jobLabel(3)), { target: { value: 'A new job' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.plan.build) }))
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true))
  const body = JSON.parse(String(fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')![1]!.body))
  expect(body.jobs).toEqual([
    { title: 'Add the sign-in page', done: ['it works'], paths: ['src/auth/login.ts'] },
    { title: 'Say thanks', done: [] },
    { title: 'A new job', done: [] },
  ])
})

const measure = { simple: true, reasons: [r.simple(2)], entries: ['src/ui/Footer.tsx', 'src/ui/footer/'] }
const planBlock = { id: 'plan', kind: 'plan' as const, label: 'Plan', enabled: true, config: {}, position: { x: 0, y: 0 } }
const detailsBody = { blockId: 'plan', label: 'Plan', kind: 'plan', state: 'passed', attempt: 1, startedAt: null, finishedAt: null, durationMs: null, model: null, tokens: null, summary: strings.plan.startedOnItsOwn, steps: [], jobs: [], commands: [], planMeasure: measure }

test('a plan that started on its own says so, offers "See the plan", and the window says why and what it expects to change', async () => {
  let seq = 0
  const fold = (type: string, payload: Record<string, unknown>) => {
    state = foldEvent(state, { sequence: ++seq, type: type as never, payload })
  }
  let state = emptyStream
  fold('node.started', { blockId: 'plan' })
  fold('node.plan_measured', { blockId: 'plan', simple: true, reasons: measure.reasons, entries: measure.entries })
  fold('node.completed', { blockId: 'plan', summary: strings.plan.startedOnItsOwn, summarySource: 'system', autoStarted: true })
  const view = toViews(state.nodes, [planBlock]).plan!
  expect(view.autoStarted).toBe(true)
  expect(view.planMeasure).toEqual(measure)
  expect(view.summary).toBe('Simple change, so it started on its own.')

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(detailsBody))))
  const onDetails = vi.fn()
  phone(<BlockCard block={planBlock} view={view} onDetails={onDetails} />)
  expect(screen.getByText('Simple change, so it started on its own.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'See the plan' }))
  expect(onDetails).toHaveBeenCalled()
  fits()

  render(<BlockDetailsDialog runId="r1" blockId="plan" label="Plan" view={view} onClose={() => {}} />)
  const dialog = await screen.findByTestId('block-details')
  await screen.findByText(strings.plan.whyStarted)
  expect(dialog).toHaveTextContent(measure.reasons[0]!)
  expect(dialog).toHaveTextContent(strings.plan.expects)
  expect(dialog).toHaveTextContent('src/ui/Footer.tsx')
  expect(dialog).toHaveTextContent('src/ui/footer/')
})

test('a plan that stopped is explained in the window under "Why it stopped for you", and an empty list says the planner did not say', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...detailsBody, planMeasure: { simple: false, reasons: [r.noPaths], entries: [] } }))))
  render(<BlockDetailsDialog runId="r1" blockId="plan" label="Plan" view={{ state: 'passed', summary: 'x', summaryIsClaim: false }} onClose={() => {}} />)
  await screen.findByText(strings.plan.whyStopped)
  expect(screen.getByTestId('block-details')).toHaveTextContent(strings.plan.noneExpected)
})

test('a plan waiting on a planner question shows the question, not the plan to check', async () => {
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
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/findings') ? new Response(JSON.stringify({ findings: [], question: null, touched: [] })) : url.endsWith('/prompts') ? new Response('{"prompts":[]}') : new Response('{}', { status: 404 }))))
  const graph = defaultGraph()
  render(<CanvasScreen workflowId="w1" graph={graph} run={{ runId: 'r1', providerId: 'other-provider', blocks: graph.blocks }} />)
  let n = 0
  const emit = (type: string, payload: Record<string, unknown>) =>
    act(async () => {
      FakeEventSource.all.at(-1)!.onmessage?.({ data: JSON.stringify({ id: `e${++n}`, runId: 'r1', nodeRunId: null, sequence: n, type, payload, createdAt: '' }) })
    })
  await emit('run.started', {})
  await emit('node.started', { blockId: 'plan' })
  await emit('node.waiting_approval', { blockId: 'plan', summary: 'Split into 2 jobs.' })
  await emit('run.waiting_approval', { blockId: 'plan' })
  expect(screen.getByTestId('command-card')).toHaveAttribute('data-mode', 'plan')
  // A question from another block is open at the same time: the question comes first, and the plan's buttons are not offered.
  await emit('node.question_asked', { blockId: 'review', questionId: 'q1', kind: 'finding' })
  expect(screen.getByTestId('command-card')).toHaveAttribute('data-mode', 'question')
  expect(screen.queryByRole('button', { name: new RegExp(strings.plan.build) })).toBeNull()
})

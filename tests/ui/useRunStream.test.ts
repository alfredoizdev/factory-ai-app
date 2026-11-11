// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { emptyStream, foldEvent, useRunStream } from '@/ui/canvas/useRunStream'
import { strings } from '@/ui/strings'
import type { Block } from '@/domain/graph'

class FakeEventSource {
  static all: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.all.push(this)
  }
  close() {
    this.closed = true
  }
  open() {
    act(() => this.onopen?.())
  }
  fail() {
    act(() => this.onerror?.())
  }
  send(sequence: number, type: string, payload: Record<string, unknown> = {}) {
    act(() => this.onmessage?.({ data: JSON.stringify({ id: `e${sequence}`, runId: 'r1', nodeRunId: null, sequence, type, payload, createdAt: '' }) }))
  }
}
const last = () => FakeEventSource.all.at(-1)!

beforeEach(() => {
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const blocks = [{ id: 'build', kind: 'build' }, { id: 'rev', kind: 'review' }] as Block[]

test('folds events into one view per block', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  last().open()
  last().send(1, 'run.created')
  last().send(2, 'node.queued', { blockId: 'build' })
  last().send(3, 'node.started', { blockId: 'build', attempt: 1 })
  last().send(4, 'node.step', { blockId: 'build', text: 'writing a file' })
  last().send(5, 'node.step', { blockId: 'build', text: 'running a check' })
  const v = result.current.views['build']!
  expect(v.state).toBe('running')
  expect(v.steps).toEqual(['writing a file', 'running a check'])
  expect(v.summary).toBe(strings.summary.build.running)
  expect(v.summaryIsClaim).toBe(false)
  expect(result.current.lastSequence).toBe(5)
  expect(result.current.connected).toBe(true)
  expect(Object.keys(result.current.views)).toEqual(['build'])
})

test('a completed summary is shown as a claim, and provenance comes from claimUsed', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  last().send(1, 'node.started', { blockId: 'rev' })
  last().send(2, 'node.completed', { blockId: 'rev', summary: 'Looks good to me.' })
  expect(result.current.views['rev']).toMatchObject({ state: 'passed', summary: 'Looks good to me.', summaryIsClaim: true })
})

test('survives a run with no run.created event and with no queued event', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  last().send(7, 'node.started', { blockId: 'build' })
  expect(result.current.views['build']!.state).toBe('running')
  expect(result.current.lastSequence).toBe(7)
})

test('every node event type maps to the state it names', () => {
  const cases: [string, string][] = [
    ['node.queued', 'queued'], ['node.started', 'running'], ['node.waiting_approval', 'waiting_approval'],
    ['node.completed', 'passed'], ['node.failed', 'failed'], ['node.skipped', 'skipped'], ['node.cancelled', 'cancelled'],
  ]
  for (const [type, state] of cases) {
    FakeEventSource.all = []
    const { result, unmount } = renderHook(() => useRunStream('r1', blocks))
    last().send(1, type, { blockId: 'build' })
    expect(result.current.views['build']!.state, type).toBe(state)
    unmount()
  }
})

test('an unknown event type, or a node event without a block, changes no view but advances the cursor', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  last().send(1, 'node.started', { blockId: 'build' })
  last().send(2, 'node.teleported', { blockId: 'build' })
  last().send(3, 'node.completed', {})
  last().send(4, 'run.waiting_approval')
  expect(result.current.views['build']!.state).toBe('running')
  expect(Object.keys(result.current.views)).toEqual(['build'])
  expect(result.current.lastSequence).toBe(4)
})

test('an event already seen is not applied twice', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  last().send(1, 'node.started', { blockId: 'build' })
  last().send(2, 'node.step', { blockId: 'build', text: 'once' })
  last().send(2, 'node.step', { blockId: 'build', text: 'once' })
  expect(result.current.views['build']!.steps).toEqual(['once'])
})

test('a state the machine forbids is ignored: a finished node is not resurrected', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  last().send(1, 'node.completed', { blockId: 'build' })
  last().send(2, 'node.started', { blockId: 'build' })
  expect(result.current.views['build']!.state).toBe('passed')
})

test('reconnects from the last sequence with backoff 1s, 2s, 5s, 5s', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  expect(last().url).toBe('/api/runs/r1/events?after=0')
  last().send(1, 'node.started', { blockId: 'build' })
  last().send(2, 'node.step', { blockId: 'build', text: 'a' })
  const first = last()
  first.fail()
  expect(first.closed).toBe(true)
  expect(result.current.connected).toBe(false)

  const expectReconnect = (delay: number, after: number) => {
    const n = FakeEventSource.all.length
    act(() => vi.advanceTimersByTime(delay - 1))
    expect(FakeEventSource.all.length).toBe(n)
    act(() => vi.advanceTimersByTime(1))
    expect(FakeEventSource.all.length).toBe(n + 1)
    expect(last().url).toBe(`/api/runs/r1/events?after=${after}`)
  }
  expectReconnect(1000, 2)
  last().fail()
  expectReconnect(2000, 2)
  last().fail()
  expectReconnect(5000, 2)
  last().fail()
  expectReconnect(5000, 2)
})

test('a successful open resets the backoff, and replayed events continue the same view', () => {
  const { result } = renderHook(() => useRunStream('r1', blocks))
  last().send(1, 'node.started', { blockId: 'build' })
  last().send(2, 'node.step', { blockId: 'build', text: 'a' })
  last().fail()
  act(() => vi.advanceTimersByTime(1000))
  last().fail()
  act(() => vi.advanceTimersByTime(2000))
  last().open()
  expect(result.current.connected).toBe(true)
  last().send(3, 'node.step', { blockId: 'build', text: 'b' })
  last().fail()
  const n = FakeEventSource.all.length
  act(() => vi.advanceTimersByTime(1000))
  expect(FakeEventSource.all.length).toBe(n + 1)
  expect(result.current.views['build']!.steps).toEqual(['a', 'b'])
  expect(last().url).toBe('/api/runs/r1/events?after=3')
})

test('unmounting closes the stream and cancels a pending reconnect', () => {
  const { unmount } = renderHook(() => useRunStream('r1', blocks))
  const es = last()
  es.fail()
  unmount()
  const n = FakeEventSource.all.length
  act(() => vi.advanceTimersByTime(10_000))
  expect(FakeEventSource.all.length).toBe(n)
  expect(es.closed).toBe(true)
})

test('a system-sourced completed summary is not a claim; provider, absent and unknown markers are', () => {
  const human = [{ id: 'h', kind: 'human' }, { id: 'rev', kind: 'review' }] as Block[]
  const { result } = renderHook(() => useRunStream('r1', human))
  last().send(1, 'node.completed', { blockId: 'h', summary: strings.run.resumed, summarySource: 'system' })
  expect(result.current.views['h']).toMatchObject({ state: 'passed', summary: strings.run.resumed, summaryIsClaim: false })
  const withKinds = [0, 1, 2].map(i => ({ id: `rev${i}`, kind: 'review' })) as Block[]
  const { result: r2 } = renderHook(() => useRunStream('r1', withKinds))
  for (const [i, marker] of [['provider'], [undefined], ['robot']].entries()) {
    last().send(20 + i, 'node.completed', { blockId: `rev${i}`, summary: 'Looks fine.', ...(marker[0] ? { summarySource: marker[0] } : {}) })
  }
  for (let i = 0; i < 3; i++) expect(r2.current.views[`rev${i}`], `marker ${i}`).toMatchObject({ summary: 'Looks fine.', summaryIsClaim: true })
})

describe('foldEvent duplicate guard', () => {
  const started = foldEvent(emptyStream, { sequence: 5, type: 'node.started', payload: { blockId: 'b' } })
  const withStep = foldEvent(started, { sequence: 6, type: 'node.step', payload: { blockId: 'b', text: 'x' } })

  test('a repeated sequence changes nothing', () => {
    const again = foldEvent(withStep, { sequence: 6, type: 'node.step', payload: { blockId: 'b', text: 'x' } })
    expect(again).toBe(withStep)
    expect(again.nodes['b']!.steps).toEqual(['x'])
  })

  test('an older sequence is ignored and never moves the cursor backwards', () => {
    const old = foldEvent(withStep, { sequence: 3, type: 'node.completed', payload: { blockId: 'b' } })
    expect(old).toBe(withStep)
    expect(old.lastSequence).toBe(6)
    expect(old.nodes['b']!.state).toBe('running')
  })
})

test('switching to a new run never shows the previous run on any render', () => {
  const seen: { runId: string; states: string[] }[] = []
  const { rerender } = renderHook(
    ({ id }: { id: string }) => {
      const r = useRunStream(id, blocks)
      seen.push({ runId: id, states: Object.values(r.views).map(v => v.state) })
      return r
    },
    { initialProps: { id: 'r1' } },
  )
  last().send(1, 'node.queued', { blockId: 'build' })
  last().send(2, 'node.started', { blockId: 'build' })
  last().send(3, 'node.completed', { blockId: 'build', summary: 's' })
  expect(seen.at(-1)).toEqual({ runId: 'r1', states: ['passed'] })
  rerender({ id: 'r2' })
  const renders = seen.filter(s => s.runId === 'r2')
  expect(renders.length).toBeGreaterThan(0)
  for (const r of renders) expect(r.states).toEqual([]) // including the very first render, before any effect ran
})

test('a push lights the Ship stage as passed, measured, naming the branch', async () => {
  const { toViews } = await import('@/ui/canvas/useRunStream')
  const ship: Block = { id: 'ship', kind: 'ship', label: 'Ship', enabled: true, config: {}, position: { x: 0, y: 0 } }
  let s = foldEvent(emptyStream, { sequence: 1, type: 'node.skipped', payload: { blockId: 'ship', reason: 'later' } })
  expect(toViews(s.nodes, [ship], s.shipped).ship!.state).toBe('skipped')
  s = foldEvent(s, { sequence: 2, type: 'run.pushed', payload: { branch: 'ai/watch-buttons-x1', pullRequestUrl: null } })
  const view = toViews(s.nodes, [ship], s.shipped).ship!
  expect(view).toMatchObject({ state: 'passed', summary: strings.summary.shippedTo('ai/watch-buttons-x1'), summaryIsClaim: false })
  // A later event does not forget it.
  s = foldEvent(s, { sequence: 3, type: 'node.step', payload: { blockId: 'ship', text: 'x' } })
  expect(s.shipped).toEqual({ branch: 'ai/watch-buttons-x1' })
})

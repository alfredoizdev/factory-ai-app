// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { useRunStream } from '@/ui/canvas/useRunStream'
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

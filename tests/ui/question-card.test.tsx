// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { CommandCard } from '@/ui/canvas/CommandCard'
import { recordMark, useReviewRecord, type ReviewRecord } from '@/ui/canvas/useReviewRecord'
import type { Wire } from '@/ui/canvas/useRunStream'
import type { Question } from '@/engine/questions'
import type { FindingView } from '@/engine/finding-view'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const question: Question = {
  id: 'q1', runId: 'r1', nodeRunId: 'n1', findingId: 'f2', kind: 'finding', text: 'The change may not be safe.', why: 'The app is asking.', detail: null,
  options: [{ id: 'fix', label: 'Fix it', means: 'Changes only this.' }, { id: 'leave', label: 'Leave it as it is', means: 'Nothing changes.' }],
  recommended: 'fix', touches: [], state: 'open', answerOption: null, answerText: null, actor: null, answeredAt: null,
}
const finding = (id: string, over: Partial<FindingView> = {}): FindingView => ({
  id, title: strings.findings.title.logic, type: 'logic', state: 'open', ending: 'needs_you', outcome: strings.findings.ended.open, how: 'not_checked',
  detail: { where: '', problem: '', command: '', outputTail: '', reason: '' }, ...over,
})
const record: ReviewRecord = { findings: [finding('f1'), finding('f2'), finding('f3', { ending: 'set_aside', state: 'refuted' })], question, touched: [] }

const card = (props: Partial<Parameters<typeof CommandCard>[0]> = {}) => (
  <CommandCard mode="question" runId="r1" text="" onText={() => undefined} images={[]} onImages={() => undefined} onRun={() => undefined} canRun={false} onFollowUp={() => undefined} onSent={() => undefined} record={record} {...props} />
)

test('the question sits in the same card as the other checks, framed as waiting for the person', () => {
  render(card())
  const section = screen.getByTestId('command-card')
  expect(section).toHaveAttribute('data-mode', 'question')
  expect(section).toHaveAttribute('aria-label', strings.question.title)
  expect(screen.getByText(question.text)).toBeInTheDocument()
  expect(screen.getByText(strings.question.position(2, 2))).toBeInTheDocument() // set-aside reports are not problems to count
  expect(screen.queryByLabelText(strings.gate.reasonLabel)).toBeNull() // no second box to wonder about
})

test('the answer goes to the question\'s own route and the record is read again', async () => {
  const fetchMock = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  const changed = vi.fn()
  render(card({ onRecordChanged: changed }))
  fireEvent.click(screen.getByRole('radio', { name: /Leave it as it is/ }))
  fireEvent.click(screen.getByRole('button', { name: strings.question.confirm }))
  await waitFor(() => expect(changed).toHaveBeenCalled())
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/runs/r1/questions/q1')
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toEqual({ option: 'leave' })
})

test('a refused answer shows the sentence the server sent and the record is read again', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: strings.question.alreadyAnswered }), { status: 409 })))
  const changed = vi.fn()
  render(card({ onRecordChanged: changed }))
  fireEvent.click(screen.getByRole('radio', { name: /Fix it/ }))
  fireEvent.click(screen.getByRole('button', { name: strings.question.confirm }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.question.alreadyAnswered)
  expect(changed).toHaveBeenCalledTimes(1)
})

test('at the human check the list of what was found sits under what is being decided', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/review') ? { hash: 'h', files: [{ path: 'a.ts', added: 1, removed: 0 }], diff: '+x', truncated: false } : { status: 'stopped' }))))
  render(card({ mode: 'waiting', showFindings: true }))
  expect(await screen.findByTestId('findings-list')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: /^Needs you/ })).toBeInTheDocument()
})

test('no list when no review ran', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hash: 'h', files: [], diff: '', truncated: false }))))
  render(card({ mode: 'waiting', showFindings: false }))
  await screen.findByText(strings.gate.noFiles)
  expect(screen.queryByTestId('findings-list')).toBeNull()
})

describe('reading the record', () => {
  const ev = (sequence: number, type: Wire['type']): Wire => ({ sequence, type, payload: {} })
  test('the mark is the sequence of the latest event that changes it', () => {
    expect(recordMark([])).toBe(0)
    expect(recordMark([ev(1, 'node.started'), ev(2, 'node.question_asked'), ev(3, 'node.step')])).toBe(2)
    expect(recordMark([ev(1, 'node.findings_checked'), ev(4, 'node.finding_resolved'), ev(5, 'node.question_answered'), ev(6, 'run.started')])).toBe(5)
  })

  test('it is read when the mark moves, and not otherwise, never on a timer', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ findings: [], question: null, touched: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender } = renderHook(({ mark }) => useReviewRecord('r1', mark), { initialProps: { mark: 0 } })
    await act(async () => undefined)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.record).toEqual({ findings: [], question: null, touched: [] })
    await act(async () => void vi.advanceTimersByTime(120_000))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rerender({ mark: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rerender({ mark: 7 })
    await act(async () => undefined)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  test('nothing is read without a run', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useReviewRecord(null, 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

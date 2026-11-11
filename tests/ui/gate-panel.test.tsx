// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { GatePanel } from '@/ui/canvas/GatePanel'
import { strings } from '@/ui/strings'

const review = { hash: 'h1', files: [{ path: 'src/app/page.tsx', added: 1, removed: 1 }], diff: '-old\n+new', truncated: false }
afterEach(() => vi.unstubAllGlobals())

test('it shows what changed and sends the decision bound to the change it showed', async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('/review') ? new Response(JSON.stringify(review)) : new Response(JSON.stringify({ decision: 'approved' })))
  vi.stubGlobal('fetch', fetchMock)
  render(<GatePanel runId="r1" risk={{ level: 'low', reasons: ['1 file, 2 lines.'] }} />)
  expect(await screen.findByText('src/app/page.tsx')).toBeInTheDocument()
  expect(screen.getByText(/1 file, 2 lines\./)).toBeInTheDocument()
  fireEvent.click(screen.getByText(strings.gate.showChanges))
  expect(screen.getByTestId('gate-diff')).toHaveTextContent('+new')
  fireEvent.change(screen.getByPlaceholderText(strings.gate.reasonPlaceholder), { target: { value: 'ok' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.gate.approve) }))
  expect(await screen.findByText(strings.gate.approved)).toBeInTheDocument()
  const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/decision'))!
  expect(JSON.parse(String(init!.body))).toEqual({ decision: 'approved', reason: 'ok', diffHash: 'h1' })
  expect(screen.queryByRole('button', { name: new RegExp(strings.gate.approve) })).toBeNull() // decided once
})

test('when the change moved, it says so and shows what is there now', async () => {
  let reviews = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/review')) return new Response(JSON.stringify({ ...review, hash: `h${++reviews}` }))
    return new Response(JSON.stringify({ error: strings.gate.changedSinceSeen }), { status: 409 })
  }))
  render(<GatePanel runId="r1" />)
  await screen.findByText('src/app/page.tsx')
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.gate.reject) }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.gate.changedSinceSeen)
  await vi.waitFor(() => expect(reviews).toBe(2))
})

test('asking for changes needs a note, then sends it as the decision', async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('/review') ? new Response(JSON.stringify(review)) : url.endsWith('/preview') ? new Response(JSON.stringify({ status: 'stopped' })) : new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  render(<GatePanel runId="r1" />)
  await screen.findByText('src/app/page.tsx')
  const ask = screen.getByRole('button', { name: new RegExp(strings.gate.askChanges) })
  expect(ask).toBeDisabled()
  fireEvent.change(screen.getByPlaceholderText(strings.gate.reasonPlaceholder), { target: { value: 'thicker border' } })
  expect(ask).toBeEnabled()
  fireEvent.click(ask)
  expect(await screen.findByText(strings.gate.changesSent)).toBeInTheDocument()
  const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/decision'))!
  expect(JSON.parse(String(init!.body))).toEqual({ decision: 'changes', reason: 'thicker border', diffHash: 'h1' })
})

test('after deciding, it waits with a spinner, and says plainly if the run does not pick the decision up', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/review') ? new Response(JSON.stringify(review)) : url.endsWith('/preview') ? new Response(JSON.stringify({ status: 'stopped' })) : new Response('{}')))
    render(<GatePanel runId="r1" />)
    await screen.findByText('src/app/page.tsx')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.gate.approve) }))
    expect(await screen.findByText(strings.gate.approved)).toBeInTheDocument()
    expect(screen.getByTestId('spinner-gate')).toBeInTheDocument()
    expect(screen.queryByText(strings.gate.notPickedUp)).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(21_000))
    expect(screen.getByText(strings.gate.notPickedUp)).toBeInTheDocument()
    expect(screen.queryByTestId('spinner-gate')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

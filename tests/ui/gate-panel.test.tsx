// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { GatePanel } from '@/ui/canvas/GatePanel'
import { strings } from '@/ui/strings'

const review = { hash: 'h1', files: [{ path: 'src/app/page.tsx', added: 1, removed: 1 }], diff: '-old\n+new', truncated: false }
afterEach(() => vi.unstubAllGlobals())

test('it shows what changed and sends the decision bound to the change it showed', async () => {
  const fetchMock = vi.fn(async (url: string) =>
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
  expect(JSON.parse(String((init as RequestInit).body))).toEqual({ decision: 'approved', reason: 'ok', diffHash: 'h1' })
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

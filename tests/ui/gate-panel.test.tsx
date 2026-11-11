// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { CommandCard, type CardMode } from '@/ui/canvas/CommandCard'
import type { ComposerImage } from '@/ui/canvas/Composer'
import { strings } from '@/ui/strings'

const review = { hash: 'h1', files: [{ path: 'src/app/page.tsx', added: 1, removed: 1 }], diff: '-old\n+new', truncated: false }
afterEach(() => vi.unstubAllGlobals())

/** The card as the screen holds it: one composer whose text every section uses. */
function Card({ mode = 'waiting', risk }: { mode?: CardMode; risk?: { level: 'low' | 'high'; reasons: string[] } }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  return (
    <CommandCard
      mode={mode}
      runId="r1"
      risk={risk}
      text={text}
      onText={setText}
      images={images}
      onImages={setImages}
      onRun={() => undefined}
      canRun={text.trim() !== ''}
      onFollowUp={() => undefined}
      onSent={() => setText('')}
    />
  )
}

const routes = (decision: Response = new Response('{}')) =>
  vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('/review') ? new Response(JSON.stringify(review)) : url.endsWith('/preview') ? new Response(JSON.stringify({ status: 'stopped' })) : decision.clone())

test('waiting: it shows what changed and sends the decision bound to the change it showed, with the note', async () => {
  const fetchMock = routes()
  vi.stubGlobal('fetch', fetchMock)
  render(<Card risk={{ level: 'low', reasons: ['1 file, 2 lines.'] }} />)
  expect(await screen.findByText('src/app/page.tsx')).toBeInTheDocument()
  expect(screen.getByText(/1 file, 2 lines\./)).toBeInTheDocument()
  fireEvent.click(screen.getByText(strings.gate.showChanges))
  expect(screen.getByTestId('gate-diff')).toHaveTextContent('+new')
  fireEvent.change(screen.getByLabelText(strings.gate.reasonLabel), { target: { value: 'ok' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.gate.approve) }))
  expect(await screen.findByText(strings.gate.approved)).toBeInTheDocument()
  const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/decision'))!
  expect(JSON.parse(String(init!.body))).toEqual({ decision: 'approved', reason: 'ok', diffHash: 'h1' })
  expect(screen.queryByRole('button', { name: new RegExp(strings.gate.approve) })).toBeNull() // decided once
})

test('waiting: when the change moved, it says so and shows what is there now', async () => {
  let reviews = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/review')) return new Response(JSON.stringify({ ...review, hash: `h${++reviews}` }))
    if (url.endsWith('/preview')) return new Response(JSON.stringify({ status: 'stopped' }))
    return new Response(JSON.stringify({ error: strings.gate.changedSinceSeen }), { status: 409 })
  }))
  render(<Card />)
  await screen.findByText('src/app/page.tsx')
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.gate.reject) }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.gate.changedSinceSeen)
  await vi.waitFor(() => expect(reviews).toBe(2))
})

test('waiting: asking for changes needs a note, then sends it as the decision', async () => {
  const fetchMock = routes()
  vi.stubGlobal('fetch', fetchMock)
  render(<Card />)
  await screen.findByText('src/app/page.tsx')
  const ask = screen.getByRole('button', { name: new RegExp(strings.gate.askChanges) })
  expect(ask).toBeDisabled()
  fireEvent.change(screen.getByLabelText(strings.gate.reasonLabel), { target: { value: 'thicker border' } })
  expect(ask).toBeEnabled()
  fireEvent.click(ask)
  expect(await screen.findByText(strings.gate.changesSent)).toBeInTheDocument()
  const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/decision'))!
  expect(JSON.parse(String(init!.body))).toEqual({ decision: 'changes', reason: 'thicker border', diffHash: 'h1', attachments: [] })
})

test('waiting: after deciding it waits with a spinner, and says plainly if the run does not pick it up', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    vi.stubGlobal('fetch', routes())
    render(<Card />)
    await screen.findByText('src/app/page.tsx')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.gate.approve) }))
    expect(await screen.findByText(strings.gate.approved)).toBeInTheDocument()
    expect(screen.getByTestId('spinner-gate')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(21_000))
    expect(screen.getByText(strings.gate.notPickedUp)).toBeInTheDocument()
    expect(screen.queryByTestId('spinner-gate')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('there is one box to write in, whatever the moment', () => {
  vi.stubGlobal('fetch', routes())
  for (const mode of ['idle', 'waiting', 'done'] as const) {
    const { unmount } = render(<Card mode={mode} />)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    unmount()
  }
  render(<Card mode="working" />)
  expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  expect(screen.getByText(strings.card.working)).toBeInTheDocument()
})

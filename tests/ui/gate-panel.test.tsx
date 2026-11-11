// @vitest-environment jsdom
import { act, waitFor, fireEvent, render, screen } from '@testing-library/react'
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

const approved = { eligible: true, kept: false, delivered: false, branch: 'ai/outline-buttons-abc123', commit: null, files: [], appliedTo: null, current: 'main', returnTo: null, pushed: false, pullRequestUrl: null }

test('done: one main button per step; the name is shown with a suggestion in it, and the project can be switched there and back', async () => {
  let state: Record<string, unknown> = approved
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/branch-name')) return new Response(JSON.stringify({ name: 'ai/watch-videos-outline-abc123' }))
    if (url.endsWith('/ship')) return new Response(JSON.stringify({ pr: null, checks: [], checksDone: false, checksFailed: false, deploy: [], mergedAt: null, onHold: false }))
    if (url.endsWith('/delivery') && init?.method === 'POST') {
      const { mode, name } = JSON.parse(String(init.body)) as { mode: string; name?: string }
      if (mode === 'branch' || mode === 'apply') state = { ...state, kept: true, branch: name, commit: '1234567abc', files: ['src/app/page.tsx'], delivered: mode === 'apply' }
      if (mode === 'switch') state = { ...state, current: state.branch, returnTo: 'main' }
      if (mode === 'back') state = { ...state, current: 'main' }
      return new Response(JSON.stringify(state))
    }
    return new Response(JSON.stringify(state))
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<Card mode="done" />)
  expect(await screen.findByTestId('next-step')).toHaveTextContent(strings.delivery.nowSave)
  expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent(strings.delivery.steps[1]!)
  // The name is in sight, with the suggestion already in it, and it can be changed.
  const field = screen.getByLabelText(new RegExp(strings.delivery.branchName))
  await waitFor(() => expect(field).toHaveValue('ai/watch-videos-outline-abc123'))
  fireEvent.change(field, { target: { value: 'feature/my-name' } })
  // Developer moves wait behind Technical details.
  expect(screen.queryByRole('button', { name: new RegExp(strings.delivery.applyButton) })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.delivery.moreOptions) }))
  expect(screen.getByRole('button', { name: new RegExp(strings.delivery.applyButton) })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.delivery.keepButton) }))
  expect(await screen.findByTestId('kept')).toBeInTheDocument()
  expect(screen.getByTestId('next-step')).toHaveTextContent(strings.delivery.nowSend)
  expect(screen.getByTestId('more-options')).toHaveTextContent('feature/my-name')
  const sent = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!
  expect(JSON.parse(String(sent[1]!.body))).toEqual({ mode: 'branch', name: 'feature/my-name' })
  // Switch, then back.
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.delivery.switchButton) }))
  expect(await screen.findByTestId('on-branch')).toHaveTextContent(strings.delivery.onBranch('feature/my-name'))
  expect(screen.queryByRole('button', { name: new RegExp(strings.delivery.applyButton) })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: (n: string) => n.includes(strings.delivery.backButton('main')) }))
  expect(await screen.findByRole('button', { name: new RegExp(strings.delivery.switchButton) })).toBeInTheDocument()
})

test('done: saving with the name never opened uses the suggestion', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/branch-name')) return new Response(JSON.stringify({ name: 'ai/suggested-abc' }))
    if (url.endsWith('/delivery') && init?.method === 'POST') return new Response(JSON.stringify({ ...approved, kept: true, branch: 'ai/suggested-abc', commit: 'c', ...JSON.parse(String(init.body)) }))
    return new Response(JSON.stringify(approved))
  }))
  render(<Card mode="done" />)
  await screen.findByTestId('next-step')
  await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => String(u).endsWith('/branch-name'))).toBe(true))
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.delivery.keepButton) }))
  await screen.findByTestId('kept')
  const post = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([, i]) => i?.method === 'POST')!
  expect(JSON.parse(String(post[1]!.body))).toEqual({ mode: 'branch', name: 'ai/suggested-abc' })
})

test('a fresh task says it starts from the main branch, and offers the folder\'s branch when it differs', () => {
  vi.stubGlobal('fetch', routes())
  const base = { text: '', onText: () => {}, images: [], onImages: () => {}, onRun: () => {}, canRun: false, onFollowUp: () => {}, onSent: () => {} }
  const { unmount } = render(<CommandCard {...base} runId={null} mode="idle" startOptions={['main']} />)
  expect(screen.getByTestId('starts-from')).toHaveTextContent(strings.delivery.startsFrom('main'))
  unmount()
  const onStartFrom = vi.fn()
  render(<CommandCard {...base} runId={null} mode="idle" startOptions={['main', 'ai/buttons']} onStartFrom={onStartFrom} />)
  const select = screen.getByRole('combobox')
  expect(select).toHaveValue('main')
  fireEvent.change(select, { target: { value: 'ai/buttons' } })
  expect(onStartFrom).toHaveBeenCalledWith('ai/buttons')
})

test('shipping: open the pull request, wait for its checks, and merge only after confirming', async () => {
  const { ShipSection } = await import('@/ui/canvas/ShipSection')
  let ship: Record<string, unknown> = { pr: null, checks: [], checksDone: false, checksFailed: false, deploy: [], mergedAt: null }
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const { action } = JSON.parse(String(init.body)) as { action: string }
      ship =
        action === 'open'
          ? { ...ship, pr: { number: 9, url: 'https://gh/pr/9', state: 'open', conflicts: false }, checks: [{ name: 'CI', state: 'passed', url: null }], checksDone: true }
          : { ...ship, pr: { number: 9, url: 'https://gh/pr/9', state: 'merged', conflicts: false }, deploy: [{ name: 'Deploy', state: 'passed', url: 'https://site' }], mergedAt: new Date(0).toISOString() }
    }
    return new Response(JSON.stringify(ship))
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<ShipSection runId="r1" button={() => ({})} />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(strings.ship.shipIt) }))
  expect(await screen.findByRole('link', { name: (n: string) => n.includes(strings.ship.pr(9)) })).toHaveAttribute('href', 'https://gh/pr/9')
  expect(screen.getByText(strings.ship.allPassed, { exact: false })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: strings.ship.merge }))
  // Nothing is merged until the person confirms.
  expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.ship.yes) }))
  expect(await screen.findByText(strings.ship.merged, { exact: false })).toBeInTheDocument()
  expect(screen.getByText(strings.ship.live, { exact: false })).toBeInTheDocument()
})

test('shipping: a ready pull request can be put on hold and taken off it, and merge stays on offer', async () => {
  const { ShipSection } = await import('@/ui/canvas/ShipSection')
  let ship: Record<string, unknown> = { pr: { number: 9, url: 'https://gh/pr/9', state: 'open', conflicts: false }, checks: [], checksDone: true, checksFailed: false, deploy: [], mergedAt: null, onHold: false }
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const { action } = JSON.parse(String(init.body)) as { action: string }
      ship = { ...ship, onHold: action === 'hold' }
    }
    return new Response(JSON.stringify(ship))
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<ShipSection runId="r1" button={() => ({})} />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(strings.ship.hold) }))
  expect(await screen.findByTestId('on-hold')).toHaveTextContent(strings.ship.onHold)
  expect(screen.getByRole('button', { name: strings.ship.merge })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.ship.unhold) }))
  await waitFor(() => expect(screen.queryByTestId('on-hold')).toBeNull())
  const sent = fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST').map(([, i]) => JSON.parse(String(i!.body)).action)
  expect(sent).toEqual(['hold', 'unhold'])
})

test('done: once the pull request is open the other options go away, and once merged the card says it is finished', async () => {
  const kept = { ...approved, kept: true, branch: 'ai/x', commit: '1234567abc', pushed: true }
  let pr: Record<string, unknown> | null = { number: 5, url: 'u', state: 'open', conflicts: false }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/ship')) return new Response(JSON.stringify({ pr, checks: [], checksDone: true, checksFailed: false, deploy: [], mergedAt: null, onHold: false }))
    return new Response(JSON.stringify(kept))
  }))
  const { unmount } = render(<Card mode="done" />)
  expect(await screen.findByText(strings.delivery.nowPublish)).toBeInTheDocument()
  // Technical details keep the names, but the other ways of sending it are gone.
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.delivery.moreOptions) }))
  expect(screen.queryByRole('button', { name: new RegExp(strings.delivery.pushOnly) })).toBeNull()
  expect(screen.queryByRole('button', { name: new RegExp(strings.delivery.applyButton) })).toBeNull()
  expect(screen.getByRole('button', { name: new RegExp(strings.delivery.switchButton) })).toBeInTheDocument()
  unmount()
  pr = { ...pr, state: 'merged' }
  render(<Card mode="done" />)
  expect(await screen.findByText(strings.delivery.finished)).toBeInTheDocument()
  expect(screen.getAllByRole('listitem').every(li => li.getAttribute('aria-current') !== 'step')).toBe(true)
  expect(screen.queryByRole('button', { name: new RegExp(strings.delivery.switchButton) })).toBeNull()
})

test('waiting: the changes open large in a window over the page, which Escape closes', async () => {
  vi.stubGlobal('fetch', routes())
  render(<Card />)
  await screen.findByText('src/app/page.tsx')
  fireEvent.click(screen.getByRole('button', { name: strings.gate.expandChanges }))
  const dialog = screen.getByRole('dialog', { name: strings.gate.changesTitle })
  expect(dialog).toHaveTextContent('+new')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

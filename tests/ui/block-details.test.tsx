// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BlockCard } from '@/ui/canvas/BlockCard'
import { BlockDetailsDialog, howLong } from '@/ui/canvas/BlockDetails'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const details = {
  blockId: 'build', label: 'Build', kind: 'build', state: 'passed', attempt: 1,
  startedAt: '2026-11-11T10:00:00.000Z', finishedAt: '2026-11-11T10:02:05.000Z', durationMs: 125_000,
  model: 'opus', tokens: 115257, summary: 'I replaced **the home page** in `page.tsx`.', steps: [{ text: 'Read page.tsx', at: '2026-11-11T10:00:05.000Z' }, { text: 'Edited page.tsx', at: '2026-11-11T10:00:42.000Z' }],
  jobs: [{ title: 'Build the landing page', done: ['It has a hero'] }],
  commands: [{ command: 'npm run build', exitCode: 0, signal: null, durationMs: 2500, output: 'Compiled' }],
}

test('the details window shows what the block did, how long it took and the tokens it used', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(details))))
  render(<BlockDetailsDialog runId="r1" blockId="build" label="Build" onClose={() => {}} />)
  const dialog = await screen.findByTestId('block-details')
  expect(await screen.findByTestId('details-summary')).toHaveTextContent('I replaced the home page in page.tsx.')
  expect(dialog).toHaveTextContent('2m 5s')
  expect(dialog).toHaveTextContent('115,257')
  expect(dialog).toHaveTextContent('opus')
  expect(screen.getByTestId('details-steps')).toHaveTextContent('Edited page.tsx')
  expect(screen.getByTestId('details-steps')).toHaveTextContent('+0:42')
  expect(dialog).toHaveTextContent(strings.details.purpose.build!)
  expect(dialog).toHaveTextContent('Build the landing page')
  expect(dialog).toHaveTextContent('npm run build')
})

test('a block that ran offers its details; one still waiting its turn does not', () => {
  const block = { id: 'b', kind: 'build' as const, label: 'Build', enabled: true, config: {}, position: { x: 0, y: 0 } }
  const onDetails = vi.fn()
  const { rerender } = render(<BlockCard block={block} view={{ state: 'passed', summary: '', summaryIsClaim: false }} onDetails={onDetails} />)
  fireEvent.click(screen.getByRole('button', { name: strings.details.see }))
  expect(onDetails).toHaveBeenCalledTimes(1)
  rerender(<BlockCard block={block} view={{ state: 'queued', summary: '', summaryIsClaim: false }} onDetails={onDetails} />)
  expect(screen.queryByRole('button', { name: strings.details.see })).toBeNull()
})

test('a length of work is said the way a person would', () => {
  expect(howLong(400)).toBe(strings.details.underASecond)
  expect(howLong(41_000)).toBe('41s')
  expect(howLong(3_725_000)).toBe('1h 2m')
})

test('the Ship details show the page before and after, on a computer or on a phone', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/snapshots')) return new Response(JSON.stringify({ status: 'ready', route: '/', shots: ['before-desktop', 'after-desktop', 'before-mobile', 'after-mobile'], message: null }))
    return new Response(JSON.stringify({ ...details, blockId: 'ship', label: 'Ship', kind: 'ship', state: 'skipped', jobs: [], commands: [], steps: [] }))
  }))
  render(<BlockDetailsDialog runId="r1" blockId="ship" label="Ship" view={{ state: 'passed', summary: 'Published.', summaryIsClaim: false }} pr={{ number: 1, url: 'https://github.com/me/p/pull/1' }} onClose={() => {}} />)
  // What the card shows wins over the record: the change was published.
  expect(await screen.findByTestId('details-summary')).toHaveTextContent('Published.')
  // One tab per screen: the computer first, the phone a click away.
  for (const where of [strings.snapshots.desktop, strings.snapshots.mobile]) {
    fireEvent.click(await screen.findByRole('tab', { name: where }))
    for (const side of [strings.snapshots.before, strings.snapshots.after]) expect(screen.getByRole('img', { name: `${side} · ${where}` })).toBeInTheDocument()
  }
  // A click on a picture opens it large, over everything; closing it leaves the window open.
  fireEvent.click(screen.getByRole('button', { name: strings.details.enlarge(`${strings.snapshots.after} · ${strings.snapshots.mobile}`) }))
  expect(screen.getByTestId('large-picture')).toBeInTheDocument()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByTestId('large-picture')).toBeNull()
  expect(screen.getByTestId('block-details')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: new RegExp(strings.details.seeOnGithub(1).replace(/[()#]/g, '.')) })).toHaveAttribute('href', 'https://github.com/me/p/pull/1')
})

test('a change nobody can see has no before and after section', async () => {
  const asked = vi.fn(async (url: string) => {
    if (url.endsWith('/snapshots')) return new Response(JSON.stringify({ status: 'unneeded', route: null, shots: [], message: null }))
    if (url.endsWith('/review')) return new Response(JSON.stringify({ hash: 'h', files: [{ path: '__tests__/page.test.tsx', added: 31, removed: 0 }], diff: '+test', truncated: false }))
    if (url.endsWith('/preview')) return new Response(JSON.stringify({ status: 'stopped' }))
    return new Response(JSON.stringify({ ...details, blockId: 'human', label: 'Human check', kind: 'human', state: 'waiting_approval', jobs: [], commands: [], steps: [] }))
  })
  vi.stubGlobal('fetch', asked)
  render(<BlockDetailsDialog runId="r1" blockId="human" label="Human check" view={{ state: 'waiting_approval', summary: 'Stopped.', summaryIsClaim: false }} pr={null} onClose={() => {}} />)
  expect(await screen.findByTestId('details-summary')).toHaveTextContent('Stopped.')
  await waitFor(() => expect(asked.mock.calls.some(c => String(c[0]).endsWith('/snapshots'))).toBe(true))
  expect(screen.queryByText(strings.details.pictures)).toBeNull()
  // What is being decided on is shown here, with the change open.
  expect(await screen.findByTestId('change-under-check')).toHaveTextContent('__tests__/page.test.tsx')
  expect(screen.getByTestId('gate-diff')).toHaveTextContent('+test')
})

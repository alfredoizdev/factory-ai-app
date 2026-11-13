// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { CommandCard } from '@/ui/canvas/CommandCard'
import type { ComposerImage } from '@/ui/canvas/Composer'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const d = strings.delivery
const base = { eligible: true, passedBy: 'person', kept: false, delivered: false, branch: 'ai/x', commit: null, files: [], appliedTo: null, current: 'main', returnTo: null, pushed: false, pullRequestUrl: null, here: true, machine: null, hasRemote: true, autoShip: null }
const kept = { ...base, kept: true, commit: 'abcdef1234' }
const noPr = { pr: null, checks: [], checksDone: false, checksFailed: false, deploy: [], mergedAt: null, onHold: false }
const withPr = { ...noPr, pr: { number: 7, url: 'https://gh/pr/7', state: 'open', conflicts: false }, checksDone: true, checks: [{ name: 'CI', state: 'passed', url: null }] }

function Card() {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  return (
    <div data-testid="phone" style={{ width: 390 }}>
      <CommandCard mode="done" runId="r1" text={text} onText={setText} images={images} onImages={setImages} onRun={() => undefined} canRun={false} onFollowUp={() => undefined} onSent={() => undefined} />
    </div>
  )
}
function serve(delivery: object, ship: object = noPr) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/delivery') ? new Response(JSON.stringify(delivery)) : url.endsWith('/ship') ? new Response(JSON.stringify(ship)) : url.endsWith('/branch-name') ? new Response('{"name":"ai/x"}') : new Response('{}'))))
}
const fits = () => {
  const root = screen.getByTestId('command-card')
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth)
  const phone = screen.getByTestId('phone')
  expect(phone.scrollWidth).toBeLessThanOrEqual(phone.clientWidth)
}

test('while the app is sending it, the card says so and offers neither keep nor send', async () => {
  serve({ ...base, passedBy: 'app', autoShip: { state: 'started', step: null, reason: null, message: null } })
  render(<Card />)
  expect(await screen.findByTestId('next-step')).toHaveTextContent(d.auto.working)
  expect(screen.queryByRole('button', { name: new RegExp(d.keepButton) })).toBeNull()
  expect(screen.queryByRole('button', { name: new RegExp(strings.ship.shipIt) })).toBeNull()
  fits()
})

test('opened: a change the app passed says it passed on its own; one the person approved says they approved it', async () => {
  serve({ ...kept, passedBy: 'app', pushed: true, autoShip: { state: 'opened', step: null, reason: null, message: null } }, withPr)
  const first = render(<Card />)
  expect(await screen.findByTestId('auto-line')).toHaveTextContent(d.auto.openedByApp)
  fits()
  first.unmount()
  serve({ ...kept, passedBy: 'person', pushed: true, autoShip: { state: 'opened', step: null, reason: null, message: null } }, withPr)
  render(<Card />)
  expect(await screen.findByTestId('auto-line')).toHaveTextContent(d.auto.openedAfterYes)
})

test('stopped while sending, with no connection: one sentence, "try again", the old send button, and the error one press away', async () => {
  serve({ ...kept, passedBy: 'app', hasRemote: true, autoShip: { state: 'stopped', step: 'send', reason: 'no_connection', message: 'fatal: no origin' } })
  render(<Card />)
  const line = await screen.findByTestId('auto-line')
  expect(line).toHaveTextContent(d.auto.stopped.noConnection)
  expect(line).toHaveTextContent(d.auto.tryAgain)
  expect(await screen.findByRole('button', { name: new RegExp(strings.ship.shipIt) })).toBeInTheDocument()
  expect(screen.queryByText('fatal: no origin')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: d.auto.whatHappened }))
  expect(screen.getByText('fatal: no origin')).toBeInTheDocument()
  fits()
})

test('stopped at each step says which step', async () => {
  serve({ ...kept, passedBy: 'app', autoShip: { state: 'stopped', step: 'open', reason: 'failed', message: null } })
  const first = render(<Card />)
  expect(await screen.findByTestId('auto-line')).toHaveTextContent(d.auto.stopped.open)
  expect(screen.queryByRole('button', { name: d.auto.whatHappened })).toBeNull()
  first.unmount()
  serve({ ...base, passedBy: 'app', autoShip: { state: 'stopped', step: 'keep', reason: 'failed', message: 'x' } })
  render(<Card />)
  expect(await screen.findByTestId('auto-line')).toHaveTextContent(d.auto.stopped.keep)
  expect(screen.getByRole('button', { name: new RegExp(d.keepButton) })).toBeInTheDocument()
})

test('passed on its own with nothing sent (the old setting): says it is ready, not in the project yet', async () => {
  serve({ ...base, passedBy: 'app', autoShip: null })
  render(<Card />)
  expect(await screen.findByTestId('auto-line')).toHaveTextContent(d.auto.passedReady)
  fits()
})

test('a change the person approved, with nothing sent on its own, shows no extra line', async () => {
  serve({ ...base, passedBy: 'person', autoShip: null })
  render(<Card />)
  await screen.findByTestId('next-step')
  expect(screen.queryByTestId('auto-line')).toBeNull()
})

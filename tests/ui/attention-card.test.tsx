// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useAttention } from '@/ui/canvas/attention'
import { CommandCard, type CardMode } from '@/ui/canvas/CommandCard'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

function Card({ mode }: { mode: CardMode }) {
  const { offer, allow } = useAttention({ attention: null, waitingCount: 0, taskTitle: null })
  return <CommandCard mode={mode} runId="r1" text="" onText={() => undefined} images={[]} onImages={() => undefined} onRun={() => undefined} canRun={false} onFollowUp={() => undefined} onSent={() => undefined} notice={{ offer, onAllow: allow }} />
}

function stub(permission: string) {
  class N {
    static permission = permission
    static requestPermission = vi.fn(async () => {
      N.permission = 'granted'
      return 'granted'
    })
  }
  vi.stubGlobal('Notification', N)
  return N
}

test('while the task works, the card offers a notice from the browser, and the offer is gone once allowed', async () => {
  const N = stub('default')
  render(<Card mode="working" />)
  const button = screen.getByRole('button', { name: strings.tell.offer })
  fireEvent.click(button)
  await act(async () => undefined)
  expect(N.requestPermission).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: strings.tell.offer })).toBeNull()
  expect(screen.getByText(strings.tell.on)).toBeInTheDocument()
})

test('a browser that blocked notices is told so after the press', async () => {
  class N {
    static permission = 'default'
    static requestPermission = vi.fn(async () => {
      N.permission = 'denied'
      return 'denied'
    })
  }
  vi.stubGlobal('Notification', N)
  render(<Card mode="working" />)
  fireEvent.click(screen.getByRole('button', { name: strings.tell.offer }))
  await act(async () => undefined)
  expect(screen.getByText(strings.tell.blocked)).toBeInTheDocument()
})

test('no offer in the other modes, nor where the browser has no notices', () => {
  stub('default')
  render(<Card mode="idle" />)
  expect(screen.queryByRole('button', { name: strings.tell.offer })).toBeNull()
})

test('no offer in a browser without notices', () => {
  vi.stubGlobal('Notification', undefined)
  render(<Card mode="working" />)
  expect(screen.queryByRole('button', { name: strings.tell.offer })).toBeNull()
})

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { attentionOf, tabTitle, useAttention, type Attention } from '@/ui/canvas/attention'
import { readyToPublish } from '@/ui/canvas/shipReady'
import type { ShipState } from '@/engine/ship'
import { strings } from '@/ui/strings'

const name = strings.app.name

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  document.title = ''
})

function stubNotification(permission: 'granted' | 'default' | 'denied') {
  const made: Array<{ text: string; options?: NotificationOptions }> = []
  const requestPermission = vi.fn(async () => {
    N.permission = 'granted'
    return 'granted' as NotificationPermission
  })
  class N {
    static permission: string = permission
    static requestPermission = requestPermission
    constructor(text: string, options?: NotificationOptions) {
      made.push({ text, options })
    }
  }
  vi.stubGlobal('Notification', N)
  return { made, requestPermission }
}
const hide = (hidden: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })

describe('the words', () => {
  test('the tab title says how many wait, else that one is ready, else the name', () => {
    expect(tabTitle(2, false)).toBe(`2 waiting for you · ${name}`)
    expect(tabTitle(0, true)).toBe(`Ready to publish · ${name}`)
    expect(tabTitle(0, false)).toBe(name)
  })
  test('waiting wins over ready when both are true', () => {
    expect(tabTitle(1, true)).toBe(`1 waiting for you · ${name}`)
  })
  test('the person acts in the plan, question and human-check modes, and to publish when done and ready', () => {
    expect(attentionOf('question', false)).toBe('answer')
    expect(attentionOf('plan', false)).toBe('answer')
    expect(attentionOf('waiting', false)).toBe('answer')
    expect(attentionOf('done', true)).toBe('publish')
    expect(attentionOf('done', false)).toBeNull()
    expect(attentionOf('working', true)).toBeNull()
    expect(attentionOf('failed', true)).toBeNull()
    expect(attentionOf('idle', true)).toBeNull()
  })
})

describe('useAttention', () => {
  const props = (attention: Attention, waitingCount = 0, taskTitle: string | null = 'Crest') => ({ attention, waitingCount, taskTitle })

  test('a move to "answer" while the tab is hidden makes one notice, and the same value again makes none', () => {
    const { made } = stubNotification('granted')
    hide(true)
    const { rerender } = renderHook((p: ReturnType<typeof props>) => useAttention(p), { initialProps: props(null) })
    expect(made).toHaveLength(0)
    rerender(props('answer'))
    expect(made).toEqual([{ text: strings.tell.needsAnswer, options: { body: 'Crest' } }])
    rerender(props('answer', 1))
    expect(made).toHaveLength(1)
  })

  test('"publish" says the change is ready, and a task with no name has an empty body', () => {
    const { made } = stubNotification('granted')
    hide(true)
    const { rerender } = renderHook((p: ReturnType<typeof props>) => useAttention(p), { initialProps: props(null, 0, null) })
    rerender(props('publish', 0, null))
    expect(made).toEqual([{ text: strings.tell.readyToPublish, options: { body: '' } }])
  })

  test('a visible tab makes no notice but the title is still set, and it is put back on unmount', () => {
    const { made } = stubNotification('granted')
    hide(false)
    const { rerender, unmount } = renderHook((p: ReturnType<typeof props>) => useAttention(p), { initialProps: props(null) })
    rerender(props('answer', 2))
    expect(made).toHaveLength(0)
    expect(document.title).toBe(`2 waiting for you · ${name}`)
    unmount()
    expect(document.title).toBe(name)
  })

  test('without permission, offers to ask; allow() asks once and the offer becomes "on"', async () => {
    const { requestPermission, made } = stubNotification('default')
    hide(true)
    const { result, rerender } = renderHook((p: ReturnType<typeof props>) => useAttention(p), { initialProps: props(null) })
    expect(result.current.offer).toBe('ask')
    rerender(props('answer'))
    expect(made).toHaveLength(0)
    expect(requestPermission).not.toHaveBeenCalled()
    await act(async () => result.current.allow())
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(result.current.offer).toBe('on')
  })

  test('a browser that blocked notices is told so, and the app never asks', () => {
    const { requestPermission } = stubNotification('denied')
    const { result } = renderHook(() => useAttention(props(null)))
    expect(result.current.offer).toBe('blocked')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  test('a browser without notices offers nothing and still sets the title', () => {
    vi.stubGlobal('Notification', undefined)
    const { result } = renderHook(() => useAttention(props('answer', 3)))
    expect(result.current.offer).toBe('none')
    expect(document.title).toBe(`3 waiting for you · ${name}`)
    act(() => result.current.allow())
  })

  test('a browser whose permission cannot be read offers nothing', () => {
    class N {
      static get permission(): string {
        throw new Error('no')
      }
    }
    vi.stubGlobal('Notification', N)
    const { result } = renderHook(() => useAttention(props(null)))
    expect(result.current.offer).toBe('none')
  })
})

describe('ready to publish', () => {
  const ship = (over: Partial<ShipState> = {}, pr: Partial<NonNullable<ShipState['pr']>> | null = {}): ShipState => ({
    pr: pr === null ? null : { number: 1, url: 'u', state: 'open', conflicts: false, ...pr },
    checks: [],
    checksDone: true,
    checksFailed: false,
    deploy: [],
    mergedAt: null,
    onHold: false,
    ...over,
  })
  test('open, checks done and fine: ready', () => expect(readyToPublish(ship())).toBe(true))
  test.each([
    ['conflicts', ship({}, { conflicts: true })],
    ['on hold', ship({ onHold: true })],
    ['checks running', ship({ checksDone: false })],
    ['checks failed', ship({ checksFailed: true })],
    ['merged', ship({}, { state: 'merged' })],
    ['closed', ship({}, { state: 'closed' })],
    ['no pull request', ship({}, null)],
  ])('%s: not ready', (_n, s) => expect(readyToPublish(s)).toBe(false))
  test('nothing known: not ready', () => expect(readyToPublish(null)).toBe(false))
})

describe('telling once per need', () => {
  const p = (attention: Attention, askKey: string | null) => ({ attention, waitingCount: 1, taskTitle: 'T', askKey })
  const hook = (init: ReturnType<typeof p>) => renderHook((x: ReturnType<typeof p>) => useAttention(x), { initialProps: init })

  test('another task, or the same task asking something else, tells again; the same need never does', () => {
    const { made } = stubNotification('granted')
    hide(true)
    const { rerender } = hook(p(null, 'r1:working:'))
    rerender(p('answer', 'r1:question:q1'))
    expect(made).toHaveLength(1)
    rerender(p('answer', 'r1:waiting:'))
    expect(made).toHaveLength(2)
    rerender(p('answer', 'r2:plan:'))
    expect(made).toHaveLength(3)
    rerender(p(null, 'r2:working:'))
    rerender(p('answer', 'r2:plan:'))
    expect(made).toHaveLength(3)
  })

  test('a constructor that throws does not break the page', () => {
    class N {
      static permission = 'granted'
      constructor() {
        throw new Error('Illegal constructor')
      }
    }
    vi.stubGlobal('Notification', N)
    hide(true)
    const { rerender } = hook(p(null, 'a'))
    expect(() => rerender(p('answer', 'b'))).not.toThrow()
  })

  test('a dismissed prompt leaves the offer in place', async () => {
    class N {
      static permission = 'default'
      static requestPermission = vi.fn(async () => 'default')
    }
    vi.stubGlobal('Notification', N)
    const { result } = hook(p(null, null))
    await act(async () => result.current.allow())
    expect(result.current.offer).toBe('ask')
  })
})

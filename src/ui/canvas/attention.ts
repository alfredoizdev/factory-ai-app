'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { strings } from '@/ui/strings'
import type { CardMode } from './CommandCard'

/** What the person must do next on the open task: answer something, or publish a change that is ready. */
export type Attention = 'answer' | 'publish' | null

/** The modes in which the run waits for the person: the plan, a question, the human check. */
export function attentionOf(mode: CardMode, shipReady: boolean): Attention {
  if (mode === 'plan' || mode === 'question' || mode === 'waiting') return 'answer'
  if (mode === 'done' && shipReady) return 'publish'
  return null
}

/** The browser tab's title: how many tasks wait, else that a change is ready, else the app's name. */
export function tabTitle(waiting: number, ready: boolean): string {
  const part = waiting > 0 ? strings.tell.waitingTitle(waiting) : ready ? strings.tell.readyTitle : null
  return strings.tell.tabTitle(part)
}

const noSubscription = () => () => undefined

type Offer = 'ask' | 'on' | 'blocked' | 'none'

/** The browser's permission, or null where there are no notifications (or the browser will not say). */
function permissionNow(): NotificationPermission | null {
  try {
    if (typeof Notification === 'undefined' || !Notification) return null
    return Notification.permission
  } catch {
    return null
  }
}

function offerFor(permission: NotificationPermission | null): Offer {
  return permission === 'granted' ? 'on' : permission === 'denied' ? 'blocked' : permission === 'default' ? 'ask' : 'none'
}

/**
 * Tells the person, outside the page, that a task needs them: the tab's title always, and a browser notice when the
 * tab is hidden and the person allowed it. The permission is only ever asked for from `allow()`, which a click calls.
 */
export function useAttention({ attention, waitingCount, taskTitle, askKey = null }: { attention: Attention; waitingCount: number; taskTitle: string | null; askKey?: string | null }): { offer: Offer; allow: () => void } {
  // The browser's own answer, read where there is a browser; the server's page says nothing, so both first pages agree.
  const offer = offerFor(useSyncExternalStore(noSubscription, permissionNow, () => null))
  const [, answered] = useState(0)

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = tabTitle(waitingCount, attention === 'publish')
  }, [waitingCount, attention])
  useEffect(
    () => () => {
      if (typeof document !== 'undefined') document.title = strings.app.name
    },
    [],
  )

  // What the person was already told about: the task plus what it asks (its mode and question), never twice.
  const told = useRef(new Set<string>())
  useEffect(() => {
    if (!attention) return
    const key = `${attention}|${askKey ?? ''}`
    if (told.current.has(key)) return
    told.current.add(key)
    try {
      if (typeof document === 'undefined' || !document.hidden) return
      if (permissionNow() !== 'granted') return
      new Notification(attention === 'answer' ? strings.tell.needsAnswer : strings.tell.readyToPublish, { body: taskTitle ?? '' })
    } catch {
      // A browser that refuses to show it: the tab's title still says it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- told once per need, not per new title
  }, [attention, askKey])

  const allow = useCallback(() => {
    try {
      if (permissionNow() === null) return
      void Promise.resolve(Notification.requestPermission())
        .then(() => answered(n => n + 1))
        .catch(() => undefined)
    } catch {
      // Not allowed to ask here.
    }
  }, [])

  return { offer, allow }
}

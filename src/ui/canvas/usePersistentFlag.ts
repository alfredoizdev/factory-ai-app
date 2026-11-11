'use client'

import { useCallback, useSyncExternalStore } from 'react'

// A per-viewer convenience (is the sidebar open), remembered in this browser only. Read through
// useSyncExternalStore so the server render and the first client render agree (both use the fallback). When storage
// is unavailable (a private window, blocked site data) the value lives in memory for as long as the page does.

const listeners = new Set<() => void>()
const memory = new Map<string, boolean>()

function read(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    // Storage is unavailable: the copy kept in memory for this page is the only record.
    return memory.get(key) ?? fallback
  }
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  window.addEventListener('storage', notify)
  return () => {
    listeners.delete(notify)
    window.removeEventListener('storage', notify)
  }
}

export function usePersistentFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => read(key, fallback), () => fallback)
  const set = useCallback(
    (next: boolean) => {
      memory.set(key, next)
      try {
        window.localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Not remembered across visits, but the memory copy keeps this page working.
      }
      listeners.forEach(l => l())
    },
    [key],
  )
  return [value, set]
}

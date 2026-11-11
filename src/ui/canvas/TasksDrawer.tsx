'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { useReducedMotion } from './useReducedMotion'

export const DRAWER_WIDTH = 460

/**
 * A panel that slides in from the right over the canvas. It closes with its ✕, with Escape, or with a click on the
 * dimmed canvas behind it. Closed, it is out of the way and out of the tab order.
 */
export function TasksDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const reduced = useReducedMotion()
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    // Without preventScroll the browser scrolls the clipped canvas to bring the still-sliding panel into view, and the
    // whole background jumps sideways.
    panel.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const motion = reduced ? 'none' : undefined
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="tasks-backdrop"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 30,
          background: 'rgba(5, 7, 11, 0.45)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: motion ?? 'opacity 220ms ease-out',
        }}
      />
      <aside
        ref={panel}
        tabIndex={-1}
        aria-label={strings.history.title}
        aria-hidden={!open}
        inert={!open}
        data-testid="tasks-drawer"
        data-open={open ? 'true' : 'false'}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 31,
          width: DRAWER_WIDTH,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: theme.bg,
          borderLeft: `1px solid ${theme.border}`,
          boxShadow: open ? '-18px 0 40px rgba(0,0,0,0.45)' : 'none',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          // Closed, it is not just off screen but hidden, once it has slid out: nothing can find or scroll to it.
          visibility: open ? 'visible' : 'hidden',
          transition: motion ?? `transform 280ms cubic-bezier(0.2, 0.7, 0.2, 1), visibility 0s linear ${open ? '0s' : '280ms'}`,
          outline: 'none',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: `1px solid ${theme.border}` }}>
          <h2 style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: theme.dim }}>{strings.history.title}</h2>
          <button
            type="button"
            aria-label={strings.history.close}
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 4 }}
          >
            ✕
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}>{children}</div>
      </aside>
    </>
  )
}

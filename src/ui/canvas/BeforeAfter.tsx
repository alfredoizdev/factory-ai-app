'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Shot, SnapshotState } from '@/engine/snapshots'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'

const POLL_MS = 3000
const img = (runId: string, shot: Shot, at: string) => `/api/runs/${runId}/snapshots/${shot}?v=${encodeURIComponent(at)}`

/**
 * The before and after pictures of a run's change. When there are none for the change as it is now, `autoStart`
 * asks for them once; while they are being taken it keeps asking how it goes.
 */
export function useSnapshots(runId: string, autoStart: boolean) {
  const [state, setState] = useState<SnapshotState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef(false)

  const load = useCallback(() => {
    void fetch(`/api/runs/${runId}/snapshots`)
      .then(r => (r.ok ? (r.json() as Promise<SnapshotState>) : null))
      .then(s => s && Array.isArray(s.shots) && setState(s))
      .catch(() => undefined)
  }, [runId])

  const take = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/snapshots`, { method: 'POST' })
      const body = (await res.json().catch(() => null)) as (SnapshotState & { error?: string }) | null
      if (!res.ok || !body || !Array.isArray(body.shots)) return setError(body?.error ?? strings.snapshots.failed(''))
      setState(body)
    } catch {
      setError(strings.snapshots.failed(''))
    }
  }, [runId])

  useEffect(() => {
    asked.current = false
    load()
  }, [load])
  useEffect(() => {
    if (autoStart && state?.status === 'none' && !asked.current) {
      asked.current = true
      void take()
    }
  }, [autoStart, state?.status, take])
  useEffect(() => {
    if (state?.status !== 'working') return
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [state?.status, load])

  return { state, error, take }
}

/**
 * Final results: a small before and after of the page the change touched, which opens large. While the pictures are
 * being taken it says so; if they could not be, it says why and offers to try again.
 */
export function BeforeAfterCard({ runId, autoStart = false, compact = false, canTake = true }: { runId: string; autoStart?: boolean; compact?: boolean; canTake?: boolean }) {
  const { state, error, take } = useSnapshots(runId, autoStart)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  // A change that cannot be seen (tests, settings) has no before and after to show.
  if (!state || state.status === 'unneeded') return null
  const at = `${state.route ?? ''}-${state.shots.join(',')}`
  const hint = { fontSize: 11.5, color: theme.dim, lineHeight: 1.4 } as const
  return (
    <div
      data-testid="before-after"
      // On the canvas, a click here is about the pictures, not about the card under them.
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      style={{ display: 'grid', gap: 6, marginTop: compact ? 10 : 0, padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118' }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: theme.dim }}>{strings.snapshots.title}</div>
      {state.status === 'none' && !error && canTake && (
        <button type="button" onClick={() => void take()} style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, background: 'none', border: 'none', color: '#93c5fd', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
          <CompareIcon /> {strings.snapshots.take}
        </button>
      )}
      {state.status === 'working' && (
        <div style={{ ...hint, display: 'flex', gap: 6, alignItems: 'center' }}>
          <WorkingSpinner blockId={`snap-${runId}`} size={13} /> {state.message}
        </div>
      )}
      {state.status === 'ready' && (
        <button
          type="button"
          aria-label={strings.snapshots.open}
          onClick={() => setOpen(true)}
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 0, background: 'none', border: 'none', cursor: 'zoom-in', color: 'inherit' }}
        >
          {(['before-desktop', 'after-desktop'] as const).map(shot => (
            <figure key={shot} style={{ margin: 0, display: 'grid', gap: 3 }}>
              {state.shots.includes(shot) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img(runId, shot, at)} alt={shot.startsWith('before') ? strings.snapshots.before : strings.snapshots.after} style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', objectPosition: 'top', borderRadius: 6, border: `1px solid ${theme.border}` }} />
              ) : (
                <div style={{ aspectRatio: '16 / 10', borderRadius: 6, border: `1px dashed ${theme.border}` }} />
              )}
              <figcaption style={{ fontSize: 11, fontWeight: 700, color: shot.startsWith('before') ? theme.dim : theme.passed, textAlign: 'left' }}>
                {shot.startsWith('before') ? strings.snapshots.before : strings.snapshots.after}
              </figcaption>
            </figure>
          ))}
        </button>
      )}
      {state.status === 'ready' && (
        <button type="button" onClick={() => setOpen(true)} style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, background: 'none', border: 'none', color: '#93c5fd', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
          <CompareIcon /> {strings.snapshots.open}
        </button>
      )}
      {(state.status === 'failed' || error) && (
        <>
          <div role="alert" style={{ ...hint, color: theme.waiting }}>{error ?? state.message}</div>
          <button type="button" onClick={() => void take()} style={{ justifySelf: 'start', padding: 0, background: 'none', border: 'none', color: '#93c5fd', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {strings.snapshots.retry}
          </button>
        </>
      )}
      {open && state.status === 'ready' && <BeforeAfterModal runId={runId} state={state} at={at} onClose={close} />}
    </div>
  )
}

/** The before and after, large, side by side, on a computer screen or a phone. Closes with ✕, Escape or a click outside. */
function BeforeAfterModal({ runId, state, at, onClose }: { runId: string; state: SnapshotState; at: string; onClose: () => void }) {
  const [screen, setScreen] = useState<'desktop' | 'mobile'>('desktop')
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const tab = (value: 'desktop' | 'mobile') => ({
    padding: '5px 12px',
    borderRadius: 999,
    border: `1px solid ${screen === value ? theme.running : theme.border}`,
    background: screen === value ? theme.tint('running', 0.18) : 'transparent',
    color: screen === value ? '#cfe0ff' : theme.dim,
    fontSize: 12.5,
    fontWeight: 700,
    cursor: 'pointer',
  })
  return createPortal(
    <div data-testid="before-after-modal" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(5, 7, 11, 0.75)', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={strings.snapshots.beforeAfter}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(1400px, 100%)', height: 'min(90vh, 100%)', display: 'flex', flexDirection: 'column', background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 14, boxShadow: '0 30px 80px rgba(0,0,0,0.6)', outline: 'none', color: '#e6e9ef' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0 }}>
            <div className="factory-display" style={{ fontSize: 19 }}>{strings.snapshots.beforeAfter}</div>
            <div style={{ fontSize: 12, color: theme.dim }}>
              {state.route ? `${strings.snapshots.page(state.route)} · ` : ''}
              {strings.snapshots.what}
            </div>
          </div>
          <div role="group" style={{ display: 'flex', gap: 6 }}>
            <button type="button" aria-pressed={screen === 'desktop'} onClick={() => setScreen('desktop')} style={tab('desktop')}>
              {strings.snapshots.desktop}
            </button>
            <button type="button" aria-pressed={screen === 'mobile'} onClick={() => setScreen('mobile')} style={tab('mobile')}>
              {strings.snapshots.mobile}
            </button>
          </div>
          <button type="button" aria-label={strings.snapshots.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 6 }}>
            ✕
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start', scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}>
          {(['before', 'after'] as const).map(side => {
            const shot = `${side}-${screen}` as Shot
            return (
              <figure key={side} style={{ margin: 0, display: 'grid', gap: 8, justifyItems: 'center' }}>
                <figcaption style={{ justifySelf: 'start', fontSize: 13, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: side === 'before' ? theme.dim : theme.passed }}>
                  {side === 'before' ? strings.snapshots.before : strings.snapshots.after}
                </figcaption>
                {state.shots.includes(shot) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img(runId, shot, at)} alt={`${side === 'before' ? strings.snapshots.before : strings.snapshots.after} · ${screen === 'desktop' ? strings.snapshots.desktop : strings.snapshots.mobile}`} style={{ width: screen === 'desktop' ? '100%' : 'min(100%, 390px)', borderRadius: 8, border: `1px solid ${side === 'before' ? theme.border : theme.tint('passed', 0.5)}` }} />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '16 / 10', borderRadius: 8, border: `1px dashed ${theme.border}` }} />
                )}
              </figure>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Two frames side by side: before and after. */
function CompareIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="3" width="5.5" height="10" rx="1" />
      <rect x="9" y="3" width="5.5" height="10" rx="1" />
    </svg>
  )
}

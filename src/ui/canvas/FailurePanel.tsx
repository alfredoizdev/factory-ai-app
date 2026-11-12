'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { FailedBlock, RunFailure } from '@/engine/failure'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'
import type { ComposerSend } from './Composer'
import { CardSkeleton } from './Skeleton'

const f = strings.failure
const mono = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

export type FailureActions = { see: () => void; again: () => void }

/** The end of what a command printed, short enough to hand to the agents with a request. */
export function errorExcerpt(output: string | null, lines = 25, chars = 1500): string {
  if (!output) return ''
  return output.trim().split('\n').slice(-lines).join('\n').slice(-chars)
}

/** The ready-made requests for a failure. Each is only words for the box: the person reads and sends them. */
export function fixOptions(block: FailedBlock | undefined): { key: string; label: string; text: string }[] {
  const label = block?.label ?? ''
  const excerpt = errorExcerpt(block?.output ?? null)
  const withError = (text: string) => (excerpt ? `${text}\n\n${f.errorIntro}\n${excerpt}` : text)
  return [
    { key: 'fix', label: f.options.fix.label, text: withError(f.options.fix.text(label, block?.command ?? null)) },
    { key: 'simpler', label: f.options.simpler.label, text: withError(f.options.simpler.text(label)) },
    { key: 'explain', label: f.options.explain.label, text: withError(f.options.explain.text(label)) },
    { key: 'again', label: f.options.again.label, text: f.options.again.text() },
  ]
}

/**
 * The card for a task that stopped: what failed, a way to read the error, one click to try again, and the box to
 * tell the agents how to fix it. Sending picks the work up where it stopped instead of starting over.
 */
export function FailedSection({
  runId,
  note,
  imageIds,
  imagesBusy,
  composer,
  onText,
  onFollowUp,
  actionsRef,
  onCanContinue,
}: {
  runId: string
  note: string
  imageIds: string[]
  imagesBusy: boolean
  composer: (send?: ComposerSend) => ReactNode
  onText: (v: string) => void
  onFollowUp: (runId: string) => void
  /** Filled with what the failed block's own buttons do: open the window, or try again. */
  actionsRef?: { current: FailureActions | null }
  /** Told whether the work can be picked up, once known: the failed block then offers Try again. */
  onCanContinue?: (can: boolean) => void
}) {
  const [failure, setFailure] = useState<RunFailure | null>(null)
  const [asked, setAsked] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'send' | 'again' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/failure`)
      .then(r => (r.ok ? (r.json() as Promise<RunFailure>) : null))
      .then(d => {
        if (!live || !d) return
        setFailure(d)
        onCanContinue?.(d.canContinue)
      })
      .catch(() => undefined)
      .finally(() => live && setAsked(true))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once per run
  }, [runId])

  async function send(text: string, as: 'send' | 'again') {
    setBusy(as)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/follow-up`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: text, attachments: as === 'send' ? imageIds : [] }) })
      const body = (await res.json().catch(() => null)) as { runId?: string; error?: string } | null
      if (!res.ok || !body?.runId) return setError(body?.error ?? strings.run.startFailed)
      onFollowUp(body.runId)
    } catch {
      setError(strings.run.startFailed)
    } finally {
      setBusy(null)
    }
  }

  // The failed block's own buttons reach this card through the ref.
  useEffect(() => {
    if (!actionsRef) return
    actionsRef.current = { see: () => setOpen(true), again: () => void send(f.options.again.text(), 'again') }
    return () => {
      actionsRef.current = null
    }
  })

  if (!asked) return <CardSkeleton />
  const first = failure?.failed[0]
  const can = failure?.canContinue === true
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: theme.tint('failed', 0.18), color: theme.failed }}>
          <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.5M12 16.4v.1" />
          </svg>
        </span>
        <div className="factory-display" style={{ fontSize: 17 }}>
          {f.cardTitle}
        </div>
      </div>
      <div data-testid="failure-summary" style={{ fontSize: 13.5, color: '#d6dce6', lineHeight: 1.45 }}>
        {first ? f.cardText(first.label) : f.cardTextUnknown}
      </div>
      {busy === 'again' ? (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#cfe0ff' }}>
          <WorkingSpinner blockId="again" size={15} /> {f.retrying}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>{f.cardHint}</div>
      )}
      {can ? (
        <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)', paddingTop: 10, borderTop: `1px solid ${theme.lineSoft}` }}>
          {composer({ label: f.send, onSend: () => void send(note, 'send'), enabled: busy === null && !imagesBusy && note.trim() !== '', busy: busy === 'send' })}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: theme.waiting, lineHeight: 1.45 }}>{f.cannotContinue}</div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: theme.failed, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
      {open && (
        <FailureDialog
          failure={failure}
          canContinue={can}
          onClose={() => setOpen(false)}
          onPick={text => {
            onText(text)
            setOpen(false)
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="command-card"] textarea')?.focus())
          }}
          onAgain={can ? () => (setOpen(false), void send(f.options.again.text(), 'again')) : undefined}
        />
      )}
    </>
  )
}

function RetryIcon() {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

/** The window that says what failed and why, with ready-made requests that go into the box for the agents. */
export function FailureDialog({ failure, canContinue, onClose, onPick, onAgain }: { failure: RunFailure | null; canContinue: boolean; onClose: () => void; onPick: (text: string) => void; onAgain?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const first = failure?.failed[0]
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(5, 7, 11, 0.65)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={f.title}
        data-testid="failure-dialog"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(860px, calc(100% - 32px))', maxHeight: 'calc(100% - 48px)', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', background: theme.card, border: `1px solid ${theme.tint('failed', 0.5)}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', fontSize: 14 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 22px', borderBottom: `1px solid ${theme.border}` }}>
          <h2 className="factory-display" style={{ margin: 0, fontSize: 22 }}>
            {f.title}
          </h2>
          <button type="button" aria-label={f.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 18 }}>
            ✕
          </button>
        </header>
        <div style={{ overflowY: 'auto', padding: '18px 22px 22px', display: 'grid', gap: 18, scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` }}>
          {!failure && <div style={{ color: theme.dim }}>{f.unreadable}</div>}
          {failure?.failed.length === 0 && <div style={{ color: theme.dim }}>{f.cardTextUnknown}</div>}
          {failure?.failed.map(b => (
            <section key={b.blockId} data-testid="failed-block" style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 16, color: theme.failed }}>{b.label}</strong>
                {b.message && <span style={{ color: '#d6dce6' }}>{b.message}</span>}
              </div>
              {b.command && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: theme.dim }}>
                  {f.command}
                  <code style={{ padding: '3px 8px', borderRadius: 6, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: 12.5, color: '#d6dce6' }}>{b.command}</code>
                  <span style={{ color: theme.failed }}>{f.ended(b.exitCode, b.signal)}</span>
                </div>
              )}
              {b.command && (
                <div style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 13, color: theme.dim }}>{f.output}</span>
                  <pre
                    data-testid="failure-output"
                    // Opened at its end: that is where a command says what broke.
                    ref={el => {
                      if (el) el.scrollTop = el.scrollHeight
                    }}
                    style={{ margin: 0, maxHeight: 300, overflow: 'auto', padding: 12, borderRadius: 8, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` }}>
                    {b.output ?? f.noOutput}
                  </pre>
                </div>
              )}
            </section>
          ))}
          {failure && (
            <section style={{ display: 'grid', gap: 10, paddingTop: 16, borderTop: `1px solid ${theme.border}` }}>
              <strong style={{ fontSize: 15 }}>{f.whatNow}</strong>
              {canContinue ? (
                <>
                  <span style={{ fontSize: 13, color: theme.dim }}>{f.pick}</span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                    {fixOptions(first).map(o =>
                      o.key === 'again' ? (
                        <button key={o.key} type="button" onClick={onAgain} style={optionButton}>
                          <RetryIcon /> {f.tryAgainNow}
                        </button>
                      ) : (
                        <button key={o.key} type="button" onClick={() => onPick(o.text)} style={optionButton}>
                          {o.label}
                        </button>
                      ),
                    )}
                  </div>
                </>
              ) : (
                <span style={{ fontSize: 13.5, color: theme.waiting }}>{f.cannotContinue}</span>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

const optionButton = {
  padding: '11px 14px',
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: '#0f141c',
  color: '#e6e9ef',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left' as const,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

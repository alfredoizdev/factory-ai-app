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

/** The request "Fix it for me" sends: what failed, with the end of what it printed, for the agents to read. */
export function fixRequest(block: FailedBlock | undefined): string {
  const text = f.fixText(block?.label ?? '', block?.command ?? null)
  const excerpt = errorExcerpt(block?.output ?? null)
  return excerpt ? `${text}\n\n${f.errorIntro}\n${excerpt}` : text
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
  const [busy, setBusy] = useState<'send' | 'again' | 'fix' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The failure in plain words: undefined until asked, null when there is no answer.
  const [explanation, setExplanation] = useState<string | null | undefined>(undefined)

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

  // Asked the first time the window opens, and kept: opening it again does not ask again.
  useEffect(() => {
    if (!open || explanation !== undefined) return
    let live = true
    fetch(`/api/runs/${runId}/failure/explain`, { method: 'POST' })
      .then(r => (r.ok ? (r.json() as Promise<{ explanation?: string | null }>) : null))
      .then(d => live && setExplanation(d?.explanation ?? null))
      .catch(() => live && setExplanation(null))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once, when the window first opens
  }, [open, runId])

  async function send(text: string, as: 'send' | 'again' | 'fix') {
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
    actionsRef.current = { see: () => setOpen(true), again: () => void send(f.againText, 'again') }
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
      {busy === 'again' || busy === 'fix' ? (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#cfe0ff' }}>
          <WorkingSpinner blockId="again" size={15} /> {busy === 'fix' ? f.fixing : f.retrying}
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
          explanation={explanation ?? null}
          explaining={explanation === undefined}
          onClose={() => setOpen(false)}
          onFix={() => (setOpen(false), void send(fixRequest(first), 'fix'))}
          onAgain={() => (setOpen(false), void send(f.againText, 'again'))}
          onOwn={() => {
            setOpen(false)
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="command-card"] textarea')?.focus())
          }}
        />
      )}
    </>
  )
}

function WrenchIcon() {
  return (
    <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L3.6 17.4a1.5 1.5 0 0 0 0 2.1l.9.9a1.5 1.5 0 0 0 2.1 0l5.9-5.9a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
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

/** One thing the person can do about a failure: a button that says what it does, and a line that says what happens. */
function Choice({ icon, label, help, badge, primary, onClick }: { icon: ReactNode; label: string; help: string; badge?: string; primary?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        columnGap: 12,
        rowGap: 3,
        alignItems: 'center',
        padding: primary ? '16px 18px' : '13px 18px',
        borderRadius: 10,
        border: `1px solid ${primary ? theme.running : theme.border}`,
        background: primary ? theme.running : '#0f141c',
        color: primary ? '#fff' : '#e6e9ef',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span style={{ gridRow: '1 / span 2', display: 'grid', placeItems: 'center' }}>{icon}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: primary ? 17.5 : 15.5, fontWeight: 700 }}>
        {label}
        {badge && <span style={{ padding: '1px 8px', borderRadius: 999, background: 'rgba(255,255,255,0.22)', fontSize: 11.5, fontWeight: 700 }}>{badge}</span>}
      </span>
      <span style={{ fontSize: 14, lineHeight: 1.4, color: primary ? 'rgba(255,255,255,0.88)' : theme.dim }}>{help}</span>
    </button>
  )
}

/**
 * The window for a task that stopped, in three parts: what happened, in plain words; what the person can do, each
 * choice saying what it will do; and the command's own output, folded away for whoever wants it.
 */
export function FailureDialog({
  failure,
  canContinue,
  explanation,
  explaining,
  onClose,
  onFix,
  onAgain,
  onOwn,
}: {
  failure: RunFailure | null
  canContinue: boolean
  /** The failure in plain words, when a model wrote one. Without it the window's own sentence stands. */
  explanation: string | null
  explaining: boolean
  onClose: () => void
  onFix: () => void
  onAgain: () => void
  onOwn: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const first = failure?.failed[0]
  const technical = failure?.failed.filter(b => b.command || b.message) ?? []
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(5, 7, 11, 0.65)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={f.title}
        data-testid="failure-dialog"
        onClick={e => e.stopPropagation()}
        style={{ width: `min(${technical.length > 0 ? 1240 : 720}px, calc(100% - 32px))`, maxHeight: 'calc(100% - 48px)', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', background: theme.card, border: `1px solid ${theme.tint('failed', 0.5)}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', fontSize: 14 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '18px 26px', borderBottom: `1px solid ${theme.border}` }}>
          <h2 className="factory-display" style={{ margin: 0, fontSize: 25 }}>
            {f.title}
          </h2>
          <button type="button" aria-label={f.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 18 }}>
            ✕
          </button>
        </header>
        <div style={{ overflowY: 'auto', padding: '22px 26px 26px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', alignItems: 'start', gap: 28, scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` }}>
          {!failure ? (
            <div style={{ color: theme.dim }}>{f.unreadable}</div>
          ) : (
            <>
              <div style={{ display: 'grid', gap: 22, minWidth: 0 }}>
              <section style={{ display: 'grid', gap: 10 }}>
                <strong style={{ fontSize: 17 }}>{f.happened}</strong>
                <p data-testid="failure-plain" style={{ margin: 0, fontSize: 16.5, lineHeight: 1.55, color: '#e6e9ef' }}>
                  {explanation ?? (first ? f.plain(first.label) : f.plainUnknown)}
                </p>
                {explaining && (
                  <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.dim }}>
                    <WorkingSpinner blockId="explain" size={14} /> {f.explaining}
                  </div>
                )}
                <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5, color: theme.passed }}>{f.safe}</p>
              </section>

              <section style={{ display: 'grid', gap: 10 }}>
                <strong style={{ fontSize: 17 }}>{f.whatNow}</strong>
                {canContinue ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    <Choice primary icon={<WrenchIcon />} label={f.actions.fix.label} help={f.actions.fix.help} badge={f.actions.fix.badge} onClick={onFix} />
                    <Choice icon={<RetryIcon />} label={f.actions.again.label} help={f.actions.again.help} onClick={onAgain} />
                    <Choice icon={<PencilIcon />} label={f.actions.own.label} help={f.actions.own.help} onClick={onOwn} />
                  </div>
                ) : (
                  <span style={{ fontSize: 13.5, color: theme.waiting, lineHeight: 1.5 }}>{f.cannotContinue}</span>
                )}
              </section>

              </div>
              {technical.length > 0 && (
                <section style={{ display: 'grid', gap: 12, minWidth: 0 }}>
                  <strong style={{ fontSize: 17 }}>{f.details}</strong>
                  {technical.map(b => (
                      <div key={b.blockId} data-testid="failed-block" style={{ display: 'grid', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                          <strong style={{ color: theme.failed }}>{b.label}</strong>
                          {b.message && <span style={{ color: theme.dim }}>{b.message}</span>}
                        </div>
                        {b.command && (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: theme.dim }}>
                              {f.command}
                              <code style={{ padding: '3px 8px', borderRadius: 6, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: 12.5, color: '#d6dce6' }}>{b.command}</code>
                              <span style={{ color: theme.failed }}>{f.ended(b.exitCode, b.signal)}</span>
                            </div>
                            <span style={{ fontSize: 13, color: theme.dim }}>{f.output}</span>
                            <pre
                              data-testid="failure-output"
                              style={{ margin: 0, maxHeight: 'min(50vh, 460px)', overflow: 'auto', padding: 12, borderRadius: 8, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` }}>
                              {b.output ?? f.noOutput}
                            </pre>
                          </>
                        )}
                      </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

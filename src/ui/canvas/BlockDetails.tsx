'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { BlockDetails } from '@/engine/block-details'
import type { NodeState } from '@/domain/states'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { visualStateOf } from './BlockCard'

const d = strings.details
const mono = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

/** "2m 5s", "41s", "under a second": a length of work, said the way a person would. */
export function howLong(ms: number): string {
  if (ms < 1000) return d.underASecond
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function clock(iso: string | null): string {
  if (!iso) return d.none
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? d.none : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 4, padding: '12px 14px', borderRadius: 10, background: '#0f141c', border: `1px solid ${theme.border}`, minWidth: 0 }}>
      <span style={{ fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: theme.dim }}>{label}</span>
      <span style={{ fontSize: 17, fontWeight: 700, color: theme.ink, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return <strong style={{ fontSize: 16 }}>{children}</strong>
}

/** The window behind a card's "See details": what the block did, how long it took and what it used. */
export function BlockDetailsDialog({ runId, blockId, label, onClose }: { runId: string; blockId: string; label: string; onClose: () => void }) {
  const [details, setDetails] = useState<BlockDetails | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/blocks/${encodeURIComponent(blockId)}`)
      .then(r => (r.ok ? (r.json() as Promise<BlockDetails>) : null))
      .then(v => live && setDetails(v))
      .catch(() => live && setDetails(null))
    return () => {
      live = false
    }
  }, [runId, blockId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const accent = details ? theme[visualStateOf(details.state as NodeState) ?? 'skipped'] : theme.border
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(5, 7, 11, 0.65)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={d.title(label)}
        data-testid="block-details"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(1000px, calc(100% - 32px))', maxHeight: 'calc(100% - 48px)', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', fontSize: 14 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '18px 26px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h2 className="factory-display" style={{ margin: 0, fontSize: 25 }}>
              {label}
            </h2>
            {details && <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent }}>{strings.canvas.stateLabel[details.state as NodeState] ?? details.state}</span>}
          </div>
          <button type="button" aria-label={d.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 18 }}>
            ✕
          </button>
        </header>
        <div style={{ overflowY: 'auto', padding: '22px 26px 26px', display: 'grid', gap: 22, scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` }}>
          {details === undefined && <div style={{ color: theme.dim }}>{d.loading}</div>}
          {details === null && <div style={{ color: theme.dim }}>{d.unreadable}</div>}
          {details && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Fact label={d.took} value={details.durationMs !== null ? howLong(details.durationMs) : details.startedAt ? d.stillWorking : d.none} />
                <Fact label={d.started} value={clock(details.startedAt)} />
                <Fact label={d.finished} value={clock(details.finishedAt)} />
                <Fact label={d.tokens} value={details.tokens !== null ? details.tokens.toLocaleString('en-US') : d.none} />
                {details.model && <Fact label={d.model} value={details.model} />}
                {details.attempt > 1 && <Fact label={d.attempts} value={details.attempt} />}
              </div>

              <section style={{ display: 'grid', gap: 8 }}>
                <Heading>{d.said}</Heading>
                <p data-testid="details-summary" style={{ margin: 0, fontSize: 15.5, lineHeight: 1.6, color: '#e6e9ef', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {details.summary ?? d.nothingSaid}
                </p>
              </section>

              {details.jobs.length > 0 && (
                <section style={{ display: 'grid', gap: 10 }}>
                  <Heading>{d.jobs(details.jobs.length)}</Heading>
                  <ol style={{ margin: 0, paddingLeft: 22, display: 'grid', gap: 10, fontSize: 15, lineHeight: 1.5 }}>
                    {details.jobs.map((j, i) => (
                      <li key={i}>
                        <span style={{ color: '#e6e9ef', fontWeight: 600 }}>{j.title}</span>
                        {j.done.length > 0 && (
                          <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: theme.dim, fontSize: 13.5 }}>
                            {j.done.map((c, k) => (
                              <li key={k}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <section style={{ display: 'grid', gap: 10 }}>
                <Heading>{d.steps(details.steps.length)}</Heading>
                {details.steps.length === 0 ? (
                  <span style={{ color: theme.dim }}>{d.noSteps}</span>
                ) : (
                  <ol data-testid="details-steps" style={{ margin: 0, paddingLeft: 0, listStylePosition: 'inside', display: 'grid', gap: 6, maxHeight: 320, overflowY: 'auto', fontSize: 14, lineHeight: 1.5, color: '#cfd6e2', scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` }}>
                    {details.steps.map((s, i) => (
                      <li key={i} style={{ overflowWrap: 'anywhere' }}>
                        {s}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {details.commands.length > 0 && (
                <section style={{ display: 'grid', gap: 12 }}>
                  <Heading>{d.commands}</Heading>
                  {details.commands.map((c, i) => (
                    <div key={i} style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13.5, color: theme.dim }}>
                        <code style={{ padding: '3px 8px', borderRadius: 6, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: 12.5, color: '#d6dce6' }}>{c.command}</code>
                        <span style={{ color: c.exitCode === 0 ? theme.passed : theme.failed, fontWeight: 600 }}>{c.exitCode === 0 ? d.commandPassed : strings.failure.ended(c.exitCode, c.signal)}</span>
                        {c.durationMs !== null && <span>{howLong(c.durationMs)}</span>}
                      </div>
                      {c.output && (
                        <pre style={{ margin: 0, maxHeight: 240, overflow: 'auto', padding: 12, borderRadius: 8, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` }}>
                          {c.output}
                        </pre>
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

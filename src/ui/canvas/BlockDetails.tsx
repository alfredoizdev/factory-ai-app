'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BlockCommand, BlockDetails } from '@/engine/block-details'
import type { Shot, SnapshotState } from '@/engine/snapshots'
import type { BlockKind } from '@/domain/graph'
import type { NodeState } from '@/domain/states'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { useSnapshots } from './BeforeAfter'
import { ChangeUnderCheck } from './GatePanel'
import { visualStateOf, WorkingSpinner, type CardView } from './BlockCard'
import { TypeMark } from './TypeMark'

const d = strings.details
const mono = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'
const thin = { scrollbarWidth: 'thin', scrollbarColor: `${theme.skipped} transparent` } as const
const KINDS: readonly string[] = ['input', 'plan', 'build', 'tests', 'review', 'approve', 'human', 'ship']
/** Steps shown before "Show all": enough to follow the work without a wall of lines. */
const FEW_STEPS = 8
/** The frame a before or after picture sits in: one height for computer and phone. */
const PICTURE_HEIGHT = 'min(48vh, 440px)'

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
  return Number.isNaN(t.getTime()) ? d.none : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** How far into the work a step happened: "+0:42". Empty when either time is missing. */
export function sinceStart(startedAt: string | null, at: string): string {
  const ms = startedAt ? Date.parse(at) - Date.parse(startedAt) : NaN
  if (!Number.isFinite(ms)) return ''
  const s = Math.max(0, Math.round(ms / 1000))
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** An agent's sentence with its `code` set apart and its **emphasis** marks dropped: readable, never raw markup. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {text
        .replace(/\*\*/g, '')
        .split(/\n{2,}/)
        .map((para, i) => (
          <p key={i} style={{ margin: 0 }}>
            {para.split('`').map((part, k) =>
              k % 2 === 1 ? (
                <code key={k} style={{ padding: '1px 6px', borderRadius: 5, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: '0.86em', color: '#cfe0ff' }}>
                  {part}
                </code>
              ) : (
                part
              ),
            )}
          </p>
        ))}
    </>
  )
}

function Icon({ path, size = 16 }: { path: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {path}
    </svg>
  )
}
const ICON = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" />,
  flag: <path d="M6 21V4h11l-2 4 2 4H6" />,
  spark: <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.4L12 17l-1.9-5.6L4.5 10l5.6-1.4z" />,
  chip: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  repeat: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  enlarge: <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />,
}

function Fact({ icon, label, value, help }: { icon: ReactNode; label: string; value: ReactNode; help?: string }) {
  return (
    <div style={{ display: 'grid', gap: 5, padding: '13px 15px', borderRadius: 12, background: '#0f141c', border: `1px solid ${theme.border}`, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: theme.dim }}>
        <Icon path={icon} size={14} /> {label}
      </span>
      <span style={{ fontSize: 19, fontWeight: 700, color: theme.ink, overflowWrap: 'anywhere' }}>{value}</span>
      {help && <span style={{ fontSize: 11.5, color: theme.skipped }}>{help}</span>}
    </div>
  )
}

function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 3 }}>
        <strong className="factory-display" style={{ fontSize: 17 }}>
          {title}
        </strong>
        {help && <span style={{ fontSize: 13, color: theme.dim }}>{help}</span>}
      </div>
      {children}
    </section>
  )
}

/** Why the plan stopped for the person or started on its own, and the files or folders the planner expects to change. */
function PlanWhy({ measure, startedOnItsOwn }: { measure: { reasons: string[]; entries: string[] }; startedOnItsOwn: boolean }) {
  return (
    <>
      {measure.reasons.length > 0 && (
        <Section title={startedOnItsOwn ? strings.plan.whyStarted : strings.plan.whyStopped}>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6, fontSize: 14.5, lineHeight: 1.5, color: '#d6dce6', overflowWrap: 'anywhere' }}>
            {measure.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={strings.plan.expects}>
        {measure.entries.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4, fontFamily: mono, fontSize: 13, color: '#d6dce6', overflowWrap: 'anywhere' }}>
            {measure.entries.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : (
          <span style={{ color: theme.dim }}>{strings.plan.noneExpected}</span>
        )}
      </Section>
    </>
  )
}

/** One check the block ran: whether it passed, how long it took, and what it printed, folded away. */
function Command({ c }: { c: BlockCommand }) {
  const [open, setOpen] = useState(false)
  const ok = c.exitCode === 0
  return (
    <div style={{ display: 'grid', gap: 8, padding: '11px 13px', borderRadius: 10, background: '#0f141c', border: `1px solid ${ok ? theme.border : theme.tint('failed', 0.5)}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, background: theme.tint(ok ? 'passed' : 'failed', 0.16), color: ok ? theme.passed : theme.failed, fontSize: 12.5, fontWeight: 700 }}>
          <Icon path={ok ? ICON.check : ICON.cross} size={13} /> {ok ? d.commandPassed : d.commandFailed}
        </span>
        <code style={{ fontFamily: mono, fontSize: 13, color: '#e6e9ef' }}>{c.command}</code>
        {c.durationMs !== null && <span style={{ marginLeft: 'auto', fontSize: 13, color: theme.dim }}>{howLong(c.durationMs)}</span>}
      </div>
      {!ok && <span style={{ fontSize: 13, color: theme.failed }}>{strings.failure.ended(c.exitCode, c.signal)}</span>}
      {c.output && (
        <>
          <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0, background: 'none', border: 'none', color: '#9cc2ff', fontSize: 13, cursor: 'pointer' }}>
            <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none' }}>
              <Icon path={ICON.chevron} size={13} />
            </span>
            {open ? d.hideOutput : d.showOutput}
          </button>
          {open && (
            <pre style={{ margin: 0, maxHeight: 280, overflow: 'auto', padding: 12, borderRadius: 8, background: '#0b0e14', border: `1px solid ${theme.border}`, fontFamily: mono, fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...thin }}>
              {c.output}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

/** The page before and after the change, on a computer and on a phone, all four at once. */
function Pictures({ runId }: { runId: string }) {
  const { state } = useSnapshots(runId, false)
  // A change nobody can see (tests, settings) has no before and after: the section is left out.
  if (!state || state.status === 'unneeded') return null
  return (
    <Section title={d.pictures} help={d.picturesHelp}>
      <PicturesBody runId={runId} state={state} />
    </Section>
  )
}

function PicturesBody({ runId, state }: { runId: string; state: SnapshotState }) {
  const [screen, setScreen] = useState<'desktop' | 'mobile'>('desktop')
  const [large, setLarge] = useState<Shot | null>(null)
  if (state.status === 'working') {
    return (
      <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.dim }}>
        <WorkingSpinner blockId="pictures" size={15} /> {d.picturesWorking}
      </span>
    )
  }
  if (state.status !== 'ready' || state.shots.length === 0) return <span style={{ color: theme.dim }}>{d.noPictures}</span>
  const src = (shot: Shot) => `/api/runs/${runId}/snapshots/${shot}`
  const tab = (value: 'desktop' | 'mobile') => ({
    padding: '7px 16px',
    borderRadius: 999,
    border: `1px solid ${screen === value ? theme.running : theme.border}`,
    background: screen === value ? theme.tint('running', 0.18) : 'transparent',
    color: screen === value ? '#cfe0ff' : theme.dim,
    fontSize: 13.5,
    fontWeight: 700,
    cursor: 'pointer',
  })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div role="tablist" style={{ display: 'flex', gap: 8 }}>
        {(['desktop', 'mobile'] as const).map(value => (
          <button key={value} type="button" role="tab" aria-selected={screen === value} onClick={() => setScreen(value)} style={tab(value)}>
            {strings.snapshots[value]}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignItems: 'start' }}>
        {(['before', 'after'] as const).map(side => {
          const shot = `${side}-${screen}` as Shot
          const label = `${strings.snapshots[side]} · ${strings.snapshots[screen]}`
          return (
            <figure key={side} style={{ margin: 0, display: 'grid', gap: 6 }}>
              <figcaption style={{ justifySelf: 'start', fontSize: 13, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: side === 'before' ? theme.dim : theme.passed }}>{strings.snapshots[side]}</figcaption>
              {state.shots.includes(shot) ? (
                // The frame is the same size on either tab, so the window does not jump: a picture fits inside it,
                // and a click opens it large.
                <button type="button" aria-label={d.enlarge(label)} title={d.enlargeHint} onClick={() => setLarge(shot)} style={{ position: 'relative', height: PICTURE_HEIGHT, boxSizing: 'border-box', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflow: 'hidden', borderRadius: 8, background: '#0b0e14', border: `1px solid ${theme.border}`, padding: 8, cursor: 'zoom-in' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src(shot)} alt={label} style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', borderRadius: 6, border: `1px solid ${side === 'before' ? theme.border : theme.tint('passed', 0.5)}` }} />
                  <span style={{ position: 'absolute', right: 10, bottom: 10, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 999, background: 'rgba(11, 14, 20, 0.88)', border: `1px solid ${theme.border}`, color: '#e6e9ef', fontSize: 12.5, fontWeight: 700 }}>
                    <Icon path={ICON.enlarge} size={14} /> {d.enlargeHint}
                  </span>
                </button>
              ) : (
                <div style={{ height: PICTURE_HEIGHT, display: 'grid', placeItems: 'center', padding: 16, textAlign: 'center', borderRadius: 8, border: `1px dashed ${theme.border}`, color: theme.dim, fontSize: 13.5, lineHeight: 1.45 }}>
                  {side === 'before' ? d.noBefore : d.noAfter}
                </div>
              )}
            </figure>
          )
        })}
      </div>
      {large && <LargePicture src={src(large)} label={`${strings.snapshots[large.startsWith('before') ? 'before' : 'after']} · ${strings.snapshots[large.endsWith('mobile') ? 'mobile' : 'desktop']}`} phone={large.endsWith('mobile')} onClose={() => setLarge(null)} />}
    </div>
  )
}

/** One picture over the whole screen, at its real size or as large as fits: scrolls when the page is long. */
function LargePicture({ src, label, phone, onClose }: { src: string; label: string; phone: boolean; onClose: () => void }) {
  useEffect(() => {
    // Escape closes the picture only, not the window under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid="large-picture"
      onClick={e => {
        e.stopPropagation()
        onClose()
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', background: 'rgba(5, 7, 11, 0.94)', cursor: 'zoom-out' }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', color: '#e6e9ef' }}>
        <strong className="factory-display" style={{ fontSize: 17 }}>
          {label}
        </strong>
        <button type="button" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0f141c', color: '#e6e9ef', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
          <Icon path={ICON.cross} size={14} /> {d.close}
        </button>
      </header>
      <div style={{ overflow: 'auto', display: 'grid', justifyItems: 'center', alignItems: 'start', padding: '0 20px 24px', ...thin }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} onClick={e => e.stopPropagation()} // A phone picture is taken at twice its size for sharpness: shown at a phone's own width, not doubled.
          style={{ display: 'block', width: phone ? 'min(100%, 420px)' : undefined, maxWidth: '100%', borderRadius: 8, border: `1px solid ${theme.border}`, cursor: 'default' }}
        />
      </div>
    </div>,
    document.body,
  )
}

/**
 * The window behind a card's "See details": what the step is for, how long it took and what it used, what happened
 * in plain sentences, the plan's jobs, the pictures of the change, every step in order and the checks it ran.
 * `view` is what the card itself shows: used where the screen knows more than the record (a change that was shipped).
 */
export function BlockDetailsDialog({ runId, blockId, label, view, pr, away = null, onClose }: { runId: string; blockId: string; label: string; view?: CardView; pr?: { number: number; url: string } | null; away?: { machine: string | null } | null; onClose: () => void }) {
  const [details, setDetails] = useState<BlockDetails | null | undefined>(undefined)
  const [allSteps, setAllSteps] = useState(false)

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

  const state = (view?.state ?? details?.state ?? 'queued') as NodeState
  const accent = theme[visualStateOf(state)]
  const kind = details?.kind
  const summary = (view?.summary || details?.summary) ?? null
  const steps = details?.steps ?? []
  const shownSteps = allSteps ? steps : steps.slice(-FEW_STEPS)
  const showsPictures = kind === 'ship' || kind === 'human'
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(5, 7, 11, 0.7)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={d.title(label)}
        data-testid="block-details"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(1080px, calc(100% - 32px))', maxHeight: 'calc(100% - 48px)', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', background: theme.card, border: `1px solid ${theme.border}`, borderTop: `3px solid ${accent}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', fontSize: 14.5 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 26px', borderBottom: `1px solid ${theme.border}` }}>
          {kind && KINDS.includes(kind) && <TypeMark kind={kind as BlockKind} colour={accent} size={40} />}
          <div style={{ display: 'grid', gap: 4, flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 className="factory-display" style={{ margin: 0, fontSize: 26 }}>
                {label}
              </h2>
              {details && <span style={{ padding: '3px 11px', borderRadius: 999, background: `${accent}26`, color: accent, fontSize: 12.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{strings.canvas.stateLabel[state]}</span>}
            </div>
            {kind && d.purpose[kind] && <span style={{ fontSize: 14, color: theme.dim }}>{d.purpose[kind]}</span>}
          </div>
          <button type="button" aria-label={d.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 18 }}>
            ✕
          </button>
        </header>
        <div style={{ overflowY: 'auto', padding: '22px 26px 28px', display: 'grid', gap: 26, ...thin }}>
          {details === undefined && <div style={{ color: theme.dim }}>{d.loading}</div>}
          {details === null && <div style={{ color: theme.dim }}>{d.unreadable}</div>}
          {details && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                {details.startedAt && <Fact icon={ICON.clock} label={d.took} value={details.durationMs !== null ? howLong(details.durationMs) : d.stillWorking} />}
                {details.startedAt && <Fact icon={ICON.play} label={d.started} value={clock(details.startedAt)} />}
                {details.startedAt && details.finishedAt && <Fact icon={ICON.flag} label={d.finished} value={clock(details.finishedAt)} />}
                {details.tokens !== null && <Fact icon={ICON.spark} label={d.tokens} value={details.tokens.toLocaleString('en-US')} help={d.tokensHelp} />}
                {details.model && <Fact icon={ICON.chip} label={d.model} value={details.model} />}
                {details.attempt > 1 && <Fact icon={ICON.repeat} label={d.attempts} value={details.attempt} />}
              </div>

              <Section title={d.said} help={view?.summaryIsClaim ? d.saidByAi : undefined}>
                <div data-testid="details-summary" style={{ display: 'grid', gap: 10, padding: '14px 16px', borderRadius: 12, background: '#0f141c', borderLeft: `3px solid ${accent}`, fontSize: 15.5, lineHeight: 1.6, color: '#e6e9ef', overflowWrap: 'anywhere' }}>
                  {summary ? <Prose text={summary} /> : <span style={{ color: theme.dim }}>{d.nothingSaid}</span>}
                </div>
                {pr && kind === 'ship' && (
                  <a href={pr.url} target="_blank" rel="noreferrer" style={{ justifySelf: 'start', color: '#9cc2ff', fontSize: 14 }}>
                    {d.seeOnGithub(pr.number)} ↗
                  </a>
                )}
              </Section>

              {kind === 'human' && state === 'waiting_approval' && (
                <Section title={strings.gate.changesTitle}>
                  <ChangeUnderCheck runId={runId} risk={view?.risk} away={away} />
                </Section>
              )}

              {showsPictures && <Pictures runId={runId} />}

              {(view?.planMeasure ?? details.planMeasure) && (
                <PlanWhy measure={(view?.planMeasure ?? details.planMeasure)!} startedOnItsOwn={view?.autoStarted === true} />
              )}

              {details.jobs.length > 0 && (
                <Section title={d.jobs(details.jobs.length)}>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {details.jobs.map((j, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 12, padding: '12px 14px', borderRadius: 10, background: '#0f141c', border: `1px solid ${theme.border}` }}>
                        <span style={{ width: 26, height: 26, borderRadius: 999, display: 'grid', placeItems: 'center', background: theme.tint('waiting', 0.18), color: theme.waiting, fontSize: 13, fontWeight: 800 }}>{i + 1}</span>
                        <div style={{ display: 'grid', gap: 6 }}>
                          <span style={{ fontSize: 15, fontWeight: 600, color: '#e6e9ef', lineHeight: 1.45 }}>{j.title}</span>
                          {j.done.length > 0 && (
                            <>
                              <span style={{ fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: theme.skipped }}>{d.doneWhen}</span>
                              {j.done.map((c, k) => (
                                <span key={k} style={{ display: 'flex', gap: 8, fontSize: 13.5, lineHeight: 1.45, color: '#c9d0db' }}>
                                  <span style={{ color: theme.passed, marginTop: 2 }}>
                                    <Icon path={ICON.check} size={13} />
                                  </span>
                                  {c}
                                </span>
                              ))}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {details.commands.length > 0 && (
                <Section title={d.commands}>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {details.commands.map((c, i) => (
                      <Command key={i} c={c} />
                    ))}
                  </div>
                </Section>
              )}

              {steps.length > 0 && (
                <Section title={d.steps(steps.length)} help={d.stepsHelp}>
                  <ol data-testid="details-steps" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid' }}>
                    {shownSteps.map((s, i) => {
                      const ran = /^Running:?\s/.test(s.text)
                      const last = i === shownSteps.length - 1
                      return (
                        <li key={i} style={{ display: 'grid', gridTemplateColumns: '54px 18px minmax(0, 1fr)', columnGap: 10, alignItems: 'start' }}>
                          <span style={{ paddingTop: 2, fontFamily: mono, fontSize: 12, color: theme.skipped, textAlign: 'right' }}>{sinceStart(details.startedAt, s.at)}</span>
                          <span aria-hidden="true" style={{ display: 'grid', justifyItems: 'center', alignSelf: 'stretch', gridTemplateRows: 'auto 1fr' }}>
                            <span style={{ width: 9, height: 9, marginTop: 6, borderRadius: 999, background: last ? accent : theme.skipped }} />
                            {!last && <span style={{ width: 2, minHeight: 14, background: theme.border }} />}
                          </span>
                          <span style={{ paddingBottom: 12, fontSize: 14, lineHeight: 1.5, color: '#d6dce6', overflowWrap: 'anywhere', ...(ran ? { fontFamily: mono, fontSize: 12.5 } : {}) }}>{s.text}</span>
                        </li>
                      )
                    })}
                  </ol>
                  {steps.length > FEW_STEPS && (
                    <button type="button" onClick={() => setAllSteps(a => !a)} style={{ justifySelf: 'start', padding: '6px 12px', borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0f141c', color: '#e6e9ef', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                      {allSteps ? d.showFewer : d.showAll(steps.length)}
                    </button>
                  )}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

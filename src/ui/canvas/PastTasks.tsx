'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import type { RunSummary } from '@/engine/run'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'
import { brand } from '@/ui/brand'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'

type Status = keyof typeof strings.run.status
/** What a card's button asks for: send to GitHub, publish, put on hold, take off hold. */
type Act = 'open' | 'merge' | 'hold' | 'unhold'
const COLOUR: Record<string, string> = {
  completed: theme.passed,
  failed: theme.failed,
  cancelled: theme.skipped,
  waiting_approval: theme.waiting,
  running: theme.running,
  queued: theme.skipped,
}

/** "3 min ago", "yesterday", or the date: enough to tell tasks apart without reading a timestamp. */
export function whenText(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return strings.history.justNow
  if (minutes < 60) return strings.history.minutesAgo(minutes)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return strings.history.hoursAgo(hours)
  if (hours < 48) return strings.history.yesterday
  return new Date(iso).toLocaleDateString()
}

/**
 * Every task this flow has run, newest first. Picking one puts it back on the canvas with everything it did, and its
 * card offers what it offered then: see it in the project, send it to GitHub, continue from it.
 */
export function PastTasks({
  workflowId,
  currentRunId,
  refreshKey,
  onOpen,
  onDeleted,
  onCount,
  onWaiting,
}: {
  workflowId: string
  currentRunId: string | null
  /** Changes when the list may be stale: a run started or finished. */
  refreshKey: string
  onOpen: (runId: string) => void
  /** Called once a task is deleted, with its id: the screen leaves it if it was the one open. */
  onDeleted?: (runId: string) => void
  /** Called with how many tasks there are, each time the list is known or changes. */
  onCount?: (count: number) => void
  /** Called with how many tasks wait for the person, each time the list is known or changes. */
  onWaiting?: (count: number) => void
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The one-click step being asked of a task from its row: which task, and whether "publish" is still being confirmed.
  const [acting, setActing] = useState<{ runId: string; what: Act } | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  async function remove(runId: string) {
    setError(null)
    setDeleting(runId)
    try {
      const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        return setError(body?.error ?? strings.history.couldNotDelete)
      }
      setRuns(current => (current ?? []).filter(r => r.runId !== runId))
      setConfirming(null)
      onDeleted?.(runId)
    } catch {
      setError(strings.history.couldNotDelete)
    } finally {
      setDeleting(null)
    }
  }
  // Other tasks move on while the person looks at one: the list asks again now and then.
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 6000)
    return () => clearInterval(t)
  }, [])

  /** Sends a task to GitHub, or publishes it, from its row. The task itself is not opened. */
  async function act(runId: string, what: Act) {
    setError(null)
    setActing({ runId, what })
    try {
      const res = await fetch(`/api/runs/${runId}/ship`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: what }) })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? strings.history.actionFailed)
      }
    } catch {
      setError(strings.history.actionFailed)
    } finally {
      setActing(null)
      setAsking(null)
      setTick(n => n + 1)
    }
  }

  useEffect(() => {
    let live = true
    fetch(`/api/workflows/${workflowId}/runs`)
      .then(r => (r.ok ? (r.json() as Promise<{ runs: RunSummary[] }>) : null))
      .then(d => live && d && setRuns(d.runs))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [workflowId, refreshKey, tick])

  const count = runs?.length ?? null
  useEffect(() => {
    if (count !== null) onCount?.(count)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- told once per change of the count, not per render
  }, [count])

  const waiting = runs?.filter(r => r.status === 'waiting_approval').length ?? null
  useEffect(() => {
    if (waiting !== null) onWaiting?.(waiting)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- told once per change of the count, not per render
  }, [waiting])

  if (runs === null) return null
  if (runs.length === 0) return <p style={{ margin: 0, fontSize: 13, color: brand.faint }}>{h.empty}</p>

  // What needs the person comes first, under its own heading; the rest follows, newest first.
  const needsYou = runs.filter(needs)
  const rest = runs.filter(r => !needs(r))

  const card = (r: RunSummary) => {
    const current = r.runId === currentRunId
    const status = (r.status in strings.run.status ? r.status : 'queued') as Status
    const mine = needs(r)
    const busy = acting?.runId === r.runId
    const working = status === 'running' || status === 'queued'
    // The pill: one or two words on where the task stands, in the colour of whose turn it is.
    const pill = r.onHold
      ? { text: h.onHold, colour: brand.quiet, id: `on-hold-${r.runId}` }
      : r.next
        ? { text: h.next[r.next], colour: brand.green, id: `next-${r.runId}` }
        : status === 'waiting_approval'
          ? { text: h.waitingForYou, colour: brand.green, id: `next-${r.runId}` }
          : working
            ? { text: h.pill.working, colour: theme.running, id: `state-${r.runId}` }
            : { text: strings.run.status[status], colour: COLOUR[status] ?? brand.quiet, id: `state-${r.runId}` }
    const notes = [
      r.onHold ? h.pill.youHeld : null,
      !r.onHold && status === 'waiting_approval' ? r.why : null,
    ].filter((n): n is string => !!n)
    return (
      <li
        key={r.runId}
        style={{
          position: 'relative',
          borderRadius: 14,
          border: `1px solid ${confirming === r.runId ? theme.tint('failed', 0.6) : mine ? brand.green : current ? '#4a4a4a' : brand.line}`,
          background: brand.card,
          color: brand.text,
        }}
      >
        <button
          type="button"
          aria-label={h.delete(r.request)}
          title={h.delete(r.request)}
          onClick={() => setConfirming(c => (c === r.runId ? null : r.runId))}
          className="factory-delete"
          style={{ position: 'absolute', right: 10, top: 10, width: 30, height: 30, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 8, background: confirming === r.runId ? theme.tint('failed', 0.18) : 'transparent', border: '1px solid transparent', color: confirming === r.runId ? theme.failed : brand.faint, cursor: 'pointer' }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" />
          </svg>
        </button>
        <button
          type="button"
          data-testid={`past-task-${r.runId}`}
          aria-current={current ? 'true' : undefined}
          onClick={() => onOpen(r.runId)}
          style={{ width: '100%', textAlign: 'left', display: 'grid', gap: 8, padding: '14px 46px 14px 16px', background: 'transparent', border: 'none', borderRadius: 14, color: 'inherit', font: 'inherit', cursor: 'pointer' }}
        >
          {/* A named task shows its name first, with what was asked quieter under it. */}
          {r.title && (
            <span data-testid={`task-name-${r.runId}`} style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.parentRunId ? '↺ ' : ''}
              {r.title}
            </span>
          )}
          <span style={{ fontSize: r.title ? 13 : 14, lineHeight: 1.45, color: r.title ? brand.quiet : brand.text, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {!r.title && r.parentRunId ? '↺ ' : ''}
            {r.request}
          </span>
          {working && r.progress && (
            // How far it is: one bar per step of its flow, the one being worked on lighter than those done.
            <span data-testid={`progress-${r.runId}`} style={{ display: 'grid', gap: 6 }}>
              <span aria-hidden="true" style={{ display: 'flex', gap: 4 }}>
                {Array.from({ length: r.progress.of }, (_, i) => (
                  <span key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i + 1 < r.progress!.step ? brand.green : i + 1 === r.progress!.step ? '#9a9a9a' : brand.line }} />
                ))}
              </span>
              <span style={{ fontFamily: brand.mono, fontSize: 11.5, color: brand.quiet }}>{h.stepOf(r.progress.step, r.progress.of, r.progress.name)}</span>
            </span>
          )}
          <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontSize: 12, color: brand.quiet }}>
            <span data-testid={pill.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, background: '#222222', color: pill.colour, fontWeight: 700 }}>
              {r.onHold ? <PauseIcon /> : <span aria-hidden="true" style={{ width: 7, height: 7, flex: 'none', borderRadius: '50%', background: pill.colour }} />}
              {pill.text}
            </span>
            <span>{whenText(r.createdAt)}</span>
            {notes.map(n => (
              <span key={n} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {n}</span>
            ))}
            {r.passedOnItsOwn && <span data-testid={`on-its-own-${r.runId}`}>· {h.wentOnItsOwn}</span>}
            {r.providerId === DEMO_PROVIDER_ID && <span style={{ color: theme.waiting }}>· {h.demo}</span>}
          </span>
        </button>
        {/* The step one click can take, on the card itself: the person stays on the task they are working on. */}
        {confirming !== r.runId && (r.onHold || mine) && !(current && (r.next === 'plan' || r.next === 'check')) && (
          <div data-testid={`task-action-${r.runId}`} style={{ display: 'grid', gap: 8, margin: '0 16px', padding: '12px 0 14px', borderTop: `1px solid ${brand.line}`, fontSize: 12.5, lineHeight: 1.45, color: brand.quiet }}>
            {r.onHold ? (
              <button type="button" disabled={acting !== null} onClick={() => void act(r.runId, 'unhold')} style={rowButton(false)}>
                {busy && <WorkingSpinner blockId={`resume-${r.runId}`} size={12} />}
                {h.resume}
              </button>
            ) : asking === r.runId ? (
              <div role="group" aria-label={h.confirmPublish} style={{ display: 'grid', gap: 8 }}>
                {h.confirmPublish}
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" disabled={acting !== null} onClick={() => void act(r.runId, 'merge')} style={rowButton(true)}>
                    {busy && <WorkingSpinner blockId={`publish-${r.runId}`} size={12} />}
                    {busy ? h.publishing : h.yesPublish}
                  </button>
                  <button type="button" disabled={acting !== null} onClick={() => setAsking(null)} style={rowButton(false)}>
                    {h.noPublish}
                  </button>
                </span>
              </div>
            ) : r.next === 'publish' ? (
              <span style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={acting !== null} onClick={() => setAsking(r.runId)} style={rowButton(true)}>
                  {h.publishIt}
                </button>
                <button type="button" disabled={acting !== null} onClick={() => void act(r.runId, 'hold')} style={rowButton(false)}>
                  {busy && <WorkingSpinner blockId={`hold-${r.runId}`} size={12} />}
                  {h.holdIt}
                </button>
              </span>
            ) : r.next === 'send' ? (
              <button type="button" disabled={acting !== null} onClick={() => void act(r.runId, 'open')} style={rowButton(true)}>
                {busy && <WorkingSpinner blockId={`send-${r.runId}`} size={12} />}
                {busy ? h.sending : h.sendIt}
              </button>
            ) : (
              // A plan or a finished change has to be seen before saying yes: the button opens it.
              <button type="button" onClick={() => onOpen(r.runId)} style={rowButton(true)}>
                {h.openIt}
              </button>
            )}
          </div>
        )}
        {confirming === r.runId && (
          // Asked on the spot, inside this task's own card, never by a browser dialog: deleting cannot be undone.
          <div role="group" aria-label={h.confirm} style={{ display: 'grid', gap: 8, margin: '0 16px', padding: '12px 0 14px', borderTop: `1px solid ${theme.tint('failed', 0.3)}`, fontSize: 12.5, lineHeight: 1.45 }}>
            {h.confirm}
            <span style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={deleting !== null} onClick={() => void remove(r.runId)} style={{ ...rowButton(false), borderColor: theme.failed, background: theme.tint('failed', 0.16), color: '#fecaca' }}>
                {deleting === r.runId && <WorkingSpinner blockId={`delete-${r.runId}`} size={12} />}
                {deleting === r.runId ? h.deleting : h.yes}
              </button>
              <button type="button" disabled={deleting !== null} onClick={() => setConfirming(null)} style={rowButton(false)}>
                {h.no}
              </button>
            </span>
          </div>
        )}
      </li>
    )
  }

  const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }
  return (
    <div style={{ display: 'grid', gap: 14, fontFamily: brand.sans }}>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: theme.failed }}>
          {error}
        </p>
      )}
      {needsYou.length > 0 && (
        <section aria-label={h.needsYou} style={{ display: 'grid', gap: 10 }}>
          <h3 style={{ margin: 0, fontFamily: brand.mono, fontSize: 11.5, fontWeight: 500, letterSpacing: '0.2em', textTransform: 'uppercase', color: brand.green }}>{h.needsYou}</h3>
          <ul style={list}>{needsYou.map(card)}</ul>
        </section>
      )}
      {rest.length > 0 && <ul style={list}>{rest.map(card)}</ul>}
    </div>
  )
}

const h = strings.history

/** A task whose next step is the person's: a plan or a change to look at, sending it, or publishing it. Not one they put on hold. */
function needs(r: RunSummary): boolean {
  if (r.onHold || r.next === 'published') return false
  return r.status === 'waiting_approval' || (r.next !== null && r.next !== undefined)
}

/** A button on a task's card: green for the step that moves the task on, quiet for the other. Each takes its share of the row. */
function rowButton(main: boolean): CSSProperties {
  return {
    flex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '9px 12px',
    borderRadius: 9,
    border: `1px solid ${main ? brand.green : brand.line}`,
    background: main ? brand.green : brand.bg,
    color: main ? brand.onGreen : brand.text,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  }
}

/** Pause: two bars, in the text's own colour. */
export function PauseIcon({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
    </svg>
  )
}

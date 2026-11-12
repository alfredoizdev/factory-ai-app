'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeUnderReview } from '@/engine/approvals'
import { strings } from '@/ui/strings'
import { explained, type Touched } from '@/ui/explain'
import type { ComposerSend } from './Composer'
import { WorkingSpinner } from './BlockCard'
import { PreviewButton } from './PreviewButton'
import { BeforeAfterCard, TakePictures } from './BeforeAfter'
import { Bone } from './Skeleton'
import { FindingsList } from './FindingsList'
import type { FindingView } from '@/engine/finding-view'

/** How long a decision may wait for the run to move before the panel says it has not. */
const PICKUP_WAIT_MS = 20_000
import { theme } from '@/ui/theme'

const MONO = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

type Review = Pick<ChangeUnderReview, 'hash' | 'files' | 'diff' | 'truncated'>

/**
 * The decision at a human check, where the person can see what they are deciding on: the files that changed, the
 * change itself, and what was measured about it. A decision is sent with the hash of the change shown here, so if
 * the change moved meanwhile the server refuses it and this panel reloads what is there now.
 */
export function GateSection({
  findings,
  touched = [],
  away = null,
  runId,
  risk,
  note,
  imageIds,
  imagesBusy,
  composer,
  onSent,
  onSeeChanges,
}: {
  /** The run's working copy is on another computer: no preview or pictures from here. */
  away?: { machine: string | null } | null
  runId: string
  /** What the reviewers found and how each ended, listed under what is being decided. Absent: no review ran, nothing is listed. */
  findings?: readonly FindingView[]
  /** What the decisions named in a reason say, in their own words. */
  touched?: readonly Touched[]
  risk?: { level: 'low' | 'high'; reasons: string[] }
  /** The shared composer's text: the note recorded with a decision, and what a request for changes asks for. */
  note: string
  imageIds: string[]
  imagesBusy: boolean
  /** The shared composer, placed between what is being decided on and the buttons that decide. Its send arrow asks
   * for changes with what is written in it. */
  composer: (send: ComposerSend) => ReactNode
  onSent: () => void
  /** Opens the Human check window. When given, the change is shown there and this card keeps only the decision. */
  onSeeChanges?: () => void
}) {
  const [review, setReview] = useState<Review | null>(null)
  const [loadError, setLoadError] = useState(false)
  const reason = note
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/review`)
      .then(r => (r.ok ? (r.json() as Promise<Review>) : Promise.reject(new Error(String(r.status)))))
      .then(body => live && (setReview(body), setLoadError(false)))
      .catch(() => live && setLoadError(true))
    return () => {
      live = false
    }
  }, [runId, reload])

  async function decide(decision: 'approved' | 'rejected' | 'changes') {
    if (!review) return
    setBusy(true)
    setOutcome(null)
    try {
      const res = await fetch(`/api/runs/${runId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, reason: reason.trim() || null, diffHash: review.hash, ...(decision === 'changes' ? { attachments: imageIds } : {}) }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setOutcome({ text: body?.error ?? strings.gate.notDelivered, ok: false })
        if (res.status === 409) setReload(n => n + 1) // show what is there now
        return
      }
      setOutcome({
        // Decided here for a task running on another computer: recorded, and that computer picks it up.
        text: away ? strings.machine.sentElsewhere(away.machine) : decision === 'approved' ? strings.gate.approved : decision === 'rejected' ? strings.gate.rejected : strings.gate.changesSent,
        ok: true,
      })
      onSent()
    } catch {
      setOutcome({ text: strings.gate.notDelivered, ok: false })
    } finally {
      setBusy(false)
    }
  }

  const decided = outcome?.ok === true
  // Once decided, this panel stays only until the run moves; it closes when the run leaves waiting. If the run does
  // not move, saying "working on it" would be a guess, so after a while it says plainly that nothing picked it up.
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (!decided) return
    const timer = setTimeout(() => setStalled(true), PICKUP_WAIT_MS)
    return () => clearTimeout(timer)
  }, [decided])
  const button = (tone: 'passed' | 'failed') => ({
    flex: 1,
    padding: '9px 12px',
    borderRadius: 8,
    border: `1px solid ${theme[tone]}`,
    background: tone === 'passed' ? theme.passed : 'transparent',
    color: tone === 'passed' ? '#07090d' : theme.failed,
    fontWeight: 700,
    cursor: busy || !review || decided ? 'not-allowed' : 'pointer',
    opacity: busy || !review || decided ? 0.6 : 1,
  })

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: theme.waiting, color: '#1a1206', fontWeight: 900, fontSize: 17 }}
        >
          !
        </span>
        <div>
          <div className="factory-display" style={{ fontSize: 17, fontWeight: 700 }}>{strings.gate.title}</div>
          <div style={{ fontSize: 12.5, color: '#d9c9a3' }}>{strings.gate.waiting}</div>
        </div>
      </div>

      {risk && !onSeeChanges && (
        <div style={{ fontSize: 12.5, color: risk.level === 'low' ? theme.passed : theme.waiting, lineHeight: 1.4 }}>
          <strong>{strings.risk.label[risk.level]}:</strong> {explained(risk.reasons.join(' '), touched)}
        </div>
      )}

      {loadError && <div style={{ fontSize: 12.5, color: theme.failed }}>{strings.gate.loadFailed}</div>}
      {!review && !loadError && (
        <div aria-busy="true" aria-label={strings.gate.loading} style={{ display: 'grid', gap: 8, padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118' }}>
          <Bone width="35%" height={10} />
          <Bone height={12} />
          <Bone width="80%" height={12} />
        </div>
      )}
      {review && !onSeeChanges && <ChangesBox review={review} />}
      {review && onSeeChanges && (
        // The change itself is shown in the Human check window, where there is room for it.
        <button type="button" data-testid="see-changes" onClick={onSeeChanges} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118', color: '#e6e9ef', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ display: 'grid', gap: 2 }}>
            {strings.gate.seeChanges}
            <span style={{ fontSize: 12, fontWeight: 400, color: theme.dim }}>{review.files.length === 0 ? strings.gate.noFiles : strings.gate.filesChanged(review.files.length)}</span>
          </span>
          <span aria-hidden="true" style={{ flex: 'none', display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 8, background: theme.tint('running', 0.16), color: theme.running }}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
          </span>
        </button>
      )}

      {findings && <FindingsList findings={findings} touched={touched} />}

      {/* Before and after pictures, taken as soon as the change reaches the person. */}
      {review && review.files.length > 0 && !decided && (onSeeChanges ? <TakePictures runId={runId} autoStart={!away} /> : <BeforeAfterCard runId={runId} autoStart={!away} canTake={!away} />)}

      {/* Only a run that changed files has something to preview. */}
      {review && review.files.length > 0 && !decided && !away && !onSeeChanges && <PreviewButton runId={runId} />}
      {away && !decided && <div style={{ fontSize: 12, color: theme.dim, lineHeight: 1.4 }}>{strings.machine.elsewhere(away.machine)}</div>}

      {/* Not yes, not no: the arrow in the box sends it back to the builder with what is written there. */}
      {!decided &&
        composer({
          label: strings.gate.askChanges,
          onSend: () => void decide('changes'),
          enabled: !busy && review !== null && !imagesBusy && reason.trim() !== '',
        })}

      {!decided && (
        <div style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: `1px solid ${theme.lineSoft}` }}>
          <button type="button" disabled={busy || !review || imagesBusy} onClick={() => void decide('approved')} style={button('passed')}>
            {busy ? strings.gate.deciding : `✓ ${strings.gate.approve}`}
          </button>
          <button type="button" disabled={busy || !review || imagesBusy} onClick={() => void decide('rejected')} style={button('failed')}>
            ✕ {strings.gate.reject}
          </button>
        </div>
      )}
      {outcome && (
        <div role={outcome.ok ? 'status' : 'alert'} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: outcome.ok ? theme.passed : theme.failed }}>
          {outcome.ok && !stalled && <WorkingSpinner blockId="gate" size={16} />}
          {outcome.text}
        </div>
      )}
      {decided && stalled && (
        <div role="alert" style={{ fontSize: 12.5, color: theme.waiting, lineHeight: 1.4 }}>
          {strings.gate.notPickedUp}
        </div>
      )}
    </>
  )
}

/** The change, line by line: added in green, removed in red, positions in blue. Long lines wrap. */
function DiffLines({ diff, truncated }: { diff: string; truncated: boolean }) {
  return (
    <>
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          style={{
            color: line.startsWith('+') ? '#86efac' : line.startsWith('-') ? '#fca5a5' : line.startsWith('@@') ? '#93c5fd' : '#9aa5b6',
            // Long lines wrap instead of running off the side; the indent keeps the +/− marker readable.
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            paddingLeft: '1.2em',
            textIndent: '-1.2em',
          }}
        >
          {line || ' '}
        </div>
      ))}
      {truncated && <div style={{ color: theme.waiting }}>{strings.gate.truncated}</div>}
    </>
  )
}

/**
 * What changed: the files, and the change itself. In the side card it is small, with the change folded and a button
 * that opens it large; with room (the Human check window) the change is open from the start.
 */
export function ChangesBox({ review, roomy = false }: { review: Review; roomy?: boolean }) {
  const [shown, setShown] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const showDiff = roomy || shown
  return (
    <>
      {/* What changed, in its own card with its own scroll: opening it never pushes the box and the buttons out. */}
      <div
        data-testid="gate-changes"
        style={{ display: 'grid', gap: 6, maxHeight: roomy ? 'min(56vh, 600px)' : showDiff ? 260 : 180, overflowY: 'auto', padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118', scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 12.5, color: theme.dim }}>{review.files.length === 0 ? strings.gate.noFiles : strings.gate.filesChanged(review.files.length)}</div>
          {review.diff && !roomy && (
            <button
              type="button"
              aria-label={strings.gate.expandChanges}
              title={strings.gate.expandChanges}
              onClick={() => setExpanded(true)}
              style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, padding: 0, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.card, color: '#d6dce6', cursor: 'pointer' }}
            >
              <ExpandIcon />
            </button>
          )}
        </div>
        {review.files.slice(0, 8).map(f => (
          <div key={f.path} style={{ display: 'flex', gap: 8, fontFamily: MONO, fontSize: 12, color: '#d6dce6' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>
              {f.path}
            </span>
            <span style={{ color: theme.passed }}>+{f.added}</span>
            <span style={{ color: theme.failed }}>−{f.removed}</span>
          </div>
        ))}
        {review.files.length > 8 && <div style={{ fontSize: 12, color: theme.dim }}>{strings.canvas.andMore(review.files.length - 8)}</div>}
        {review.diff && !roomy && (
          <button type="button" onClick={() => setShown(v => !v)} style={{ justifySelf: 'start', background: 'none', border: 'none', color: theme.running, cursor: 'pointer', padding: 0, fontSize: 12.5 }}>
            {showDiff ? strings.gate.hideChanges : strings.gate.showChanges}
          </button>
        )}
        {showDiff && (
          <pre data-testid="gate-diff" style={{ margin: 0, background: '#0b0e14', border: `1px solid ${theme.border}`, borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.5 }}>
            <DiffLines diff={review.diff} truncated={review.truncated} />
          </pre>
        )}
      </div>
      {expanded && review && <ChangesModal files={review.files} diff={review.diff} truncated={review.truncated} onClose={() => setExpanded(false)} />}
    </>
  )
}

/** What is being decided on, for the Human check window: why it needs the person, the change, and a way to try it. */
export function ChangeUnderCheck({ runId, risk, away = null }: { runId: string; risk?: { level: 'low' | 'high'; reasons: string[] }; away?: { machine: string | null } | null }) {
  const [review, setReview] = useState<Review | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/review`)
      .then(r => (r.ok ? (r.json() as Promise<Review>) : Promise.reject(new Error(String(r.status)))))
      .then(body => live && setReview(body))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [runId])
  if (failed) return <div style={{ fontSize: 13, color: theme.failed }}>{strings.gate.loadFailed}</div>
  if (!review) return <Bone height={60} radius={10} />
  return (
    <div data-testid="change-under-check" style={{ display: 'grid', gap: 12 }}>
      {risk && (
        <div style={{ fontSize: 13.5, color: risk.level === 'low' ? theme.passed : theme.waiting, lineHeight: 1.5 }}>
          <strong>{strings.risk.label[risk.level]}:</strong> {explained(risk.reasons.join(' '))}
        </div>
      )}
      <ChangesBox review={review} roomy />
      {review.files.length > 0 && !away && <PreviewButton runId={runId} />}
      {away && <div style={{ fontSize: 12.5, color: theme.dim }}>{strings.machine.elsewhere(away.machine)}</div>}
    </div>
  )
}

/** The whole change, large, over the page. Closes with its ✕, Escape, or a click outside it. */
function ChangesModal({ files, diff, truncated, onClose }: { files: Review['files']; diff: string; truncated: boolean; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div
      data-testid="changes-modal"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(5, 7, 11, 0.7)', display: 'grid', gridTemplateRows: 'minmax(0, 1fr)', gridTemplateColumns: 'minmax(0, 1fr)', placeItems: 'center', padding: 24 }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={strings.gate.changesTitle}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(1100px, 100%)', height: 'min(86vh, calc(100vh - 48px))', minHeight: 0, display: 'flex', flexDirection: 'column', background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 14, boxShadow: '0 30px 80px rgba(0,0,0,0.6)', outline: 'none', color: '#e6e9ef' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ display: 'grid', gap: 2 }}>
            <div className="factory-display" style={{ fontSize: 19 }}>{strings.gate.changesTitle}</div>
            <div style={{ fontSize: 12, color: theme.dim, fontFamily: MONO }}>
              {files.map(f => `${f.path} +${f.added} −${f.removed}`).join('   ·   ')}
            </div>
          </div>
          <button type="button" aria-label={strings.gate.closeChanges} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 6 }}>
            ✕
          </button>
        </header>
        <pre style={{ flex: 1, minHeight: 0, margin: 0, overflow: 'auto', padding: 16, fontFamily: MONO, fontSize: 13, lineHeight: 1.55, background: '#0b0e14', borderRadius: '0 0 14px 14px', scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}>
          <DiffLines diff={diff} truncated={truncated} />
        </pre>
      </div>
    </div>,
    document.body,
  )
}

/** Expand: two arrows pointing out to the corners. */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
    </svg>
  )
}

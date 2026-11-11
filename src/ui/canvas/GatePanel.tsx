'use client'

import { forwardRef, useEffect, useState } from 'react'
import type { ChangeUnderReview } from '@/engine/approvals'
import { strings } from '@/ui/strings'
import { WorkingSpinner } from './BlockCard'
import { PreviewButton } from './PreviewButton'

/** How long a decision may wait for the run to move before the panel says it has not. */
const PICKUP_WAIT_MS = 20_000
import { theme } from '@/ui/theme'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

type Review = Pick<ChangeUnderReview, 'hash' | 'files' | 'diff' | 'truncated'>

/**
 * The decision at a human check, where the person can see what they are deciding on: the files that changed, the
 * change itself, and what was measured about it. A decision is sent with the hash of the change shown here, so if
 * the change moved meanwhile the server refuses it and this panel reloads what is there now.
 */
export const GatePanel = forwardRef<HTMLElement, { runId: string; risk?: { level: 'low' | 'high'; reasons: string[] } }>(function GatePanel(
  { runId, risk },
  ref,
) {
  const [review, setReview] = useState<Review | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [reason, setReason] = useState('')
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
        body: JSON.stringify({ decision, reason: reason.trim() || null, diffHash: review.hash }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setOutcome({ text: body?.error ?? strings.gate.notDelivered, ok: false })
        if (res.status === 409) setReload(n => n + 1) // show what is there now
        return
      }
      setOutcome({
        text: decision === 'approved' ? strings.gate.approved : decision === 'rejected' ? strings.gate.rejected : strings.gate.changesSent,
        ok: true,
      })
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
    <section
      ref={ref}
      tabIndex={-1}
      data-testid="gate-panel"
      aria-label={strings.gate.title}
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 5,
        // Wider while the change is open, so code lines are readable without scrolling sideways.
        width: showDiff ? 'min(760px, 60vw)' : 460,
        transition: 'width 160ms ease-out',
        maxHeight: 'calc(100% - 32px)',
        overflowY: 'auto',
        background: 'linear-gradient(180deg, #1f1a10 0%, #16130d 100%)',
        border: `1px solid ${theme.tint('waiting', 0.55)}`,
        borderRadius: 14,
        boxShadow: `0 0 0 1px ${theme.tint('waiting', 0.2)}, 0 0 30px ${theme.tint('waiting', 0.18)}, 0 18px 40px rgba(0,0,0,0.55)`,
        padding: 16,
        display: 'grid',
        gap: 12,
        outline: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: theme.waiting, color: '#1a1206', fontWeight: 900, fontSize: 17 }}
        >
          !
        </span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{strings.gate.title}</div>
          <div style={{ fontSize: 12.5, color: '#d9c9a3' }}>{strings.gate.waiting}</div>
        </div>
      </div>

      {risk && (
        <div style={{ fontSize: 12.5, color: risk.level === 'low' ? theme.passed : theme.waiting, lineHeight: 1.4 }}>
          <strong>{strings.risk.label[risk.level]}:</strong> {risk.reasons.join(' ')}
        </div>
      )}

      {loadError && <div style={{ fontSize: 12.5, color: theme.failed }}>{strings.gate.loadFailed}</div>}
      {!review && !loadError && <div style={{ fontSize: 12.5, color: theme.dim }}>{strings.gate.loading}</div>}
      {review && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 12.5, color: theme.dim }}>{review.files.length === 0 ? strings.gate.noFiles : strings.gate.filesChanged(review.files.length)}</div>
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
          {review.diff && (
            <button type="button" onClick={() => setShowDiff(v => !v)} style={{ justifySelf: 'start', background: 'none', border: 'none', color: theme.running, cursor: 'pointer', padding: 0, fontSize: 12.5 }}>
              {showDiff ? strings.gate.hideChanges : strings.gate.showChanges}
            </button>
          )}
          {showDiff && (
            <pre data-testid="gate-diff" style={{ margin: 0, maxHeight: '50vh', overflow: 'auto', background: '#0b0e14', border: `1px solid ${theme.border}`, borderRadius: 8, padding: 12, fontSize: 12.5, lineHeight: 1.5 }}>
              {review.diff.split('\n').map((line, i) => (
                <div key={i} style={{ color: line.startsWith('+') ? '#86efac' : line.startsWith('-') ? '#fca5a5' : line.startsWith('@@') ? '#93c5fd' : '#9aa5b6',
                  // Long lines wrap instead of running off the side; the indent keeps the +/− marker readable.
                  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingLeft: '1.2em', textIndent: '-1.2em' }}>
                  {line || ' '}
                </div>
              ))}
              {review.truncated && <div style={{ color: theme.waiting }}>{strings.gate.truncated}</div>}
            </pre>
          )}
        </div>
      )}

      {/* Only a run that changed files has something to preview. */}
      {review && review.files.length > 0 && !decided && <PreviewButton runId={runId} />}

      {!decided && (
        <label style={{ display: 'grid', gap: 4, fontSize: 12.5, color: theme.dim }}>
          {strings.gate.reasonLabel}
          <textarea
            value={reason}
            rows={2}
            placeholder={strings.gate.reasonPlaceholder}
            onChange={e => setReason(e.target.value)}
            style={{ resize: 'vertical', padding: '7px 9px', background: theme.card, color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 6, font: 'inherit', fontSize: 13 }}
          />
        </label>
      )}

      {!decided && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" disabled={busy || !review} onClick={() => void decide('approved')} style={button('passed')}>
            {busy ? strings.gate.deciding : `✓ ${strings.gate.approve}`}
          </button>
          <button type="button" disabled={busy || !review} onClick={() => void decide('rejected')} style={button('failed')}>
            ✕ {strings.gate.reject}
          </button>
        </div>
      )}
      {!decided && (
        // Not yes, not no: back to the builder in the same copy, with the note. The note is what it works from.
        <button
          type="button"
          disabled={busy || !review || reason.trim() === ''}
          title={reason.trim() === '' ? strings.gate.changesHint : undefined}
          onClick={() => void decide('changes')}
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${theme.running}`,
            background: reason.trim() ? theme.tint('running', 0.16) : 'transparent',
            color: reason.trim() ? '#cfe0ff' : theme.skipped,
            fontWeight: 700,
            cursor: busy || !review || reason.trim() === '' ? 'not-allowed' : 'pointer',
          }}
        >
          ↺ {strings.gate.askChanges}
        </button>
      )}
      {!decided && reason.trim() === '' && <div style={{ fontSize: 11.5, color: theme.skipped, marginTop: -6 }}>{strings.gate.changesHint}</div>}
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
    </section>
  )
})

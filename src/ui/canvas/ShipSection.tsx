'use client'

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { Check, ShipState } from '@/engine/ship'
import { strings } from '@/ui/strings'
import { brand } from '@/ui/brand'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'
import { PauseIcon } from './PastTasks'
import { Bone } from './Skeleton'

const POLL_MS = 8000

const MARK: Record<Check['state'], { glyph: string; colour: string }> = {
  pending: { glyph: '…', colour: theme.waiting },
  passed: { glyph: '✓', colour: theme.passed },
  failed: { glyph: '✕', colour: theme.failed },
  neutral: { glyph: '·', colour: theme.skipped },
}

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 3, fontSize: 12 }}>
      {checks.map((c, i) => (
        <li key={`${c.name}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span aria-hidden="true" style={{ color: MARK[c.state].colour, fontWeight: 800, width: 12 }}>
            {MARK[c.state].glyph}
          </span>
          {c.url ? (
            <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: brand.green }}>
              {c.name}
            </a>
          ) : (
            <span>{c.name}</span>
          )}
          <span style={{ color: theme.dim }}>{strings.ship.checkState[c.state]}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Shipping from the result card: open the pull request, watch the checks the repository runs (whatever they are),
 * then merge into main only on the person's own, confirmed click. Afterwards it shows what reported on main.
 */
export function ShipSection({
  runId,
  button,
  onState,
  canOpen = true,
  onRecorded,
}: {
  /** Told after an action GitHub accepted, so the canvas picks up what was recorded. */
  onRecorded?: () => void
  /** False on a computer without the run's working copy: sending it for checks happens there. */
  canOpen?: boolean
  runId: string
  button: (busy: unknown) => CSSProperties
  /** Told every time the shipping state is read, so the Ship card on the canvas can show the same progress. */
  onState?: (state: ShipState) => void
}) {
  // When it was read is kept with it: how long ago a merge happened is measured against that, not the clock mid-render.
  const [state, setLoaded] = useState<(ShipState & { readAt: number }) | null>(null)
  const setState = useCallback(
    (next: ShipState) => {
      setLoaded({ ...next, readAt: Date.now() })
      onState?.(next)
    },
    [onState],
  )
  const [busy, setBusy] = useState<'open' | 'merge' | 'hold' | 'unhold' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void fetch(`/api/runs/${runId}/ship`)
      .then(res => (res.ok ? (res.json() as Promise<ShipState>) : null))
      .then(next => next && setState(next))
      .catch(() => undefined)
  }, [runId, setState])

  useEffect(load, [load])

  // Keep asking while something is still on its way: checks on the open pull request, or reports after the merge.
  const open = state?.pr?.state === 'open'
  const merged = state?.pr?.state === 'merged'
  const deployPending = merged && state!.deployPending === true
  const waiting = (open && !state!.checksDone) || deployPending
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [waiting, load])

  async function act(action: 'open' | 'merge' | 'hold' | 'unhold') {
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/ship`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
      const body = (await res.json().catch(() => null)) as (ShipState & { error?: string }) | null
      if (!res.ok || !body) return setError(body?.error ?? strings.run.startFailed)
      setState(body)
      setConfirming(false)
      onRecorded?.()
    } catch {
      setError(strings.run.startFailed)
    } finally {
      setBusy(null)
    }
  }

  // Placeholders the size of what comes: GitHub takes a moment to answer, and the card must not jump when it does.
  if (state === null)
    return (
      <div data-testid="ship-skeleton" aria-busy="true" style={{ display: 'grid', gap: 6 }}>
        <Bone height={38} radius={8} />
        <Bone width="70%" height={10} />
      </div>
    )
  const hint: CSSProperties = { fontSize: 11.5, color: theme.dim, lineHeight: 1.4 }
  return (
    <div data-testid="ship-section" style={{ display: 'grid', gap: 6 }}>
      {!state.pr && canOpen && (
        <>
          <button type="button" disabled={busy !== null} onClick={() => void act('open')} style={button(busy)}>
            {busy === 'open' ? <WorkingSpinner blockId="ship-open" size={16} /> : <ShipIcon />} {busy === 'open' ? strings.ship.opening : strings.ship.shipIt}
          </button>
          <div style={{ ...hint, marginTop: -2 }}>{strings.ship.shipWhat}</div>
        </>
      )}
      {state.pr && (
        <div style={{ display: 'grid', gap: 6, fontSize: 12.5, lineHeight: 1.4 }}>
          <a href={state.pr.url} target="_blank" rel="noopener noreferrer" style={{ color: brand.green, fontWeight: 600, fontSize: 12 }}>
            {strings.ship.pr(state.pr.number)} ↗
          </a>
          {state.pr.state === 'closed' && <span style={{ color: theme.failed }}>{strings.ship.closed}</span>}
          {open && (
            <>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: theme.dim }}>{strings.ship.checksTitle}</div>
              {/* Still on its way: one clear line that says so. "No checks" is only said once GitHub has settled. */}
              {!state.checksDone && (
                <div role="status" data-testid="ship-checking" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, border: `1px solid ${theme.tint('running', 0.5)}`, background: theme.tint('running', 0.1), color: '#cfe0ff', fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>
                  <WorkingSpinner blockId="ship-checks" size={18} />
                  {state.checks.length === 0 ? strings.ship.looking : strings.ship.waiting}
                </div>
              )}
              {state.checks.length > 0 && <CheckList checks={state.checks} />}
              {state.checksDone && state.checks.length === 0 && <span style={hint}>{strings.ship.noChecks}</span>}
              {state.checksDone && state.checks.length > 0 && !state.checksFailed && <span style={{ color: theme.passed }}>✓ {strings.ship.allPassed}</span>}
              {state.checksFailed && <span style={{ color: theme.failed }}>{strings.ship.someFailed}</span>}
              {state.pr.conflicts && <span style={{ color: theme.failed }}>{strings.ship.conflicts}</span>}
              {state.onHold && (
                <div data-testid="on-hold" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: 8, borderRadius: 8, border: `1px solid ${theme.tint('waiting', 0.5)}`, background: theme.tint('waiting', 0.08), color: theme.waiting }}>
                  <span style={{ marginTop: 2 }}><PauseIcon size={12} /></span>
                  <span style={{ lineHeight: 1.4 }}>{strings.ship.onHold}</span>
                </div>
              )}
              {state.checksDone && !state.checksFailed && !state.pr.conflicts && !confirming && (
                <>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button type="button" disabled={busy !== null} onClick={() => setConfirming(true)} style={{ ...button(busy), flex: 1 }}>
                      {strings.ship.merge}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void act(state.onHold ? 'unhold' : 'hold')}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, border: `1px solid ${theme.tint('waiting', 0.6)}`, background: 'transparent', color: theme.waiting, fontWeight: 700, cursor: busy ? 'wait' : 'pointer' }}
                    >
                      {busy === 'hold' || busy === 'unhold' ? <WorkingSpinner blockId="ship-hold" size={13} /> : <PauseIcon size={11} />}
                      {busy === 'hold' ? strings.ship.holding : state.onHold ? strings.ship.unhold : strings.ship.hold}
                    </button>
                  </span>
                  {/* One line for each button, so it is plain what each one does. */}
                  <div style={{ ...hint, marginTop: -2 }}>{strings.ship.mergeWhat}</div>
                  {!state.onHold && <div style={hint}>{strings.ship.holdWhat}</div>}
                </>
              )}
              {confirming && (
                // Asked on the spot: this is the step that can change the live site.
                <div role="group" aria-label={strings.ship.confirm} style={{ display: 'grid', gap: 6, padding: 8, border: `1px solid ${theme.tint('waiting', 0.5)}`, borderRadius: 8, background: theme.tint('waiting', 0.08) }}>
                  {strings.ship.confirm}
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button type="button" disabled={busy !== null} onClick={() => void act('merge')} style={{ ...button(busy), flex: 1 }}>
                      {busy === 'merge' ? <WorkingSpinner blockId="ship-merge" size={14} /> : null} {busy === 'merge' ? strings.ship.merging : strings.ship.yes}
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => setConfirming(false)} style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: `1px solid ${theme.dim}`, background: brand.card, color: theme.ink, fontWeight: 600, cursor: 'pointer' }}>
                      {strings.ship.no}
                    </button>
                  </span>
                </div>
              )}
            </>
          )}
          {merged && (
            <>
              {/* Not called published until what runs on main has answered, or enough time passed to know nothing will. */}
              {deployPending ? (
                <div role="status" data-testid="ship-publishing" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, border: `1px solid ${theme.tint('running', 0.5)}`, background: theme.tint('running', 0.1), color: '#cfe0ff', fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>
                  <WorkingSpinner blockId="ship-deploy" size={18} />
                  {strings.ship.deployWaiting}
                </div>
              ) : (
                <span style={{ color: theme.passed, fontWeight: 700 }}>✓ {strings.ship.merged}</span>
              )}
              {state.folder !== undefined && <span data-testid="ship-folder" style={hint}>{state.folder ? strings.ship.folderUpdated : strings.ship.folderNot}</span>}
              {state.deploy.length > 0 && <CheckList checks={state.deploy} />}
              {!deployPending && state.deploy.length === 0 && <span style={hint}>{strings.ship.noDeploy}</span>}
              {!deployPending && state.deploy.length > 0 && !state.deploy.some(d => d.state === 'failed') && <span style={{ color: theme.passed }}>✓ {strings.ship.live}</span>}
              {state.deploy.some(d => d.state === 'failed') && <span style={{ color: theme.failed }}>{strings.ship.deployFailed}</span>}
            </>
          )}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: theme.failed, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </div>
  )
}

/** Ship: an arrow leaving a tray. Drawn in the button's own colour. */
function ShipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
    </svg>
  )
}

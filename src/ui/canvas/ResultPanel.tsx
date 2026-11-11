'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Delivery } from '@/engine/delivery'
import type { ShipState } from '@/engine/ship'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'
import { ShipSection } from './ShipSection'

/**
 * A finished, approved run: where its change is, how to bring it into the project, and how to ask for another change
 * on top of it. Bringing it over writes into the person's folder, so the button says exactly what it will do.
 */
type Mode = 'branch' | 'apply' | 'switch' | 'back' | 'push'

export function ResultSection({
  runId,
  note,
  imageIds,
  imagesBusy,
  composer,
  onFollowUp,
  onShipState,
}: {
  runId: string
  /** The shared composer's text: what to change next, on top of this approved change. */
  note: string
  imageIds: string[]
  imagesBusy: boolean
  composer: ReactNode
  onFollowUp: (runId: string) => void
  onShipState?: (state: ShipState) => void
}) {
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [busy, setBusy] = useState<Mode | 'follow' | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  // The branch name the person writes, or asks the app to suggest. Empty: one is suggested when the change is saved.
  const [branchName, setBranchName] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/delivery`)
      .then(r => (r.ok ? (r.json() as Promise<Delivery>) : null))
      .then(d => live && d && setDelivery(d))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [runId])

  // A name is suggested only when asked for: nothing fills the field behind the person's back.
  async function suggestName() {
    setSuggesting(true)
    try {
      const res = await fetch(`/api/runs/${runId}/branch-name`)
      const body = (await res.json().catch(() => null)) as { name?: string } | null
      if (res.ok && body?.name) setBranchName(body.name)
    } catch {
      // The field stays as it was; saving with it empty still gets a suggested name.
    } finally {
      setSuggesting(false)
    }
  }

  async function bring(mode: Mode) {
    setBusy(mode)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/delivery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'branch' || mode === 'apply' ? { mode, name: branchName.trim() } : { mode }),
      })
      const body = (await res.json().catch(() => null)) as (Delivery & { error?: string }) | null
      if (!res.ok || !body) return setError(body?.error ?? strings.run.startFailed)
      setDelivery(body)
    } catch {
      setError(strings.run.startFailed)
    } finally {
      setBusy(null)
    }
  }

  async function followUp() {
    setBusy('follow')
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/follow-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note, attachments: imageIds }),
      })
      const body = (await res.json().catch(() => null)) as { runId?: string; error?: string } | null
      if (!res.ok || !body?.runId) return setError(body?.error ?? strings.run.startFailed)
      onFollowUp(body.runId)
    } catch {
      setError(strings.run.startFailed)
    } finally {
      setBusy(null)
    }
  }

  // Not (yet) known to be an approved, finished run: only the composer, for a fresh request from the top bar.
  if (!delivery?.eligible) return <>{composer}</>

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: theme.passed, color: '#07110a', fontWeight: 900, fontSize: 16 }}>
          ✓
        </span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{strings.delivery.title}</div>
          <div style={{ fontSize: 12.5, color: '#b9dcc5' }}>{delivery.delivered ? strings.delivery.done(delivery.files.length) : delivery.kept ? strings.delivery.readyKept : strings.delivery.ready}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)' }}>
        {delivery.kept && delivery.branch ? (
          <div data-testid="kept" style={{ display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <div style={{ fontSize: 12.5, color: '#b9dcc5', lineHeight: 1.4, overflowWrap: 'anywhere' }}>
              {strings.delivery.keptOnBranch(delivery.branch, delivery.commit ?? '')}
            </div>
            {delivery.current === delivery.branch ? (
              <>
                <div data-testid="on-branch" style={{ fontSize: 12.5, color: theme.passed, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                  ✓ {strings.delivery.onBranch(delivery.branch)}
                </div>
                {delivery.returnTo && (
                  <button type="button" disabled={busy !== null} onClick={() => void bring('back')} style={secondaryButton(busy)}>
                    {busy === 'back' ? <WorkingSpinner blockId="back" size={16} /> : '←'} {strings.delivery.backButton(delivery.returnTo)}
                  </button>
                )}
              </>
            ) : (
              <>
                <button type="button" disabled={busy !== null} onClick={() => void bring('switch')} style={primaryButton(busy)}>
                  {busy === 'switch' ? <WorkingSpinner blockId="switch" size={16} /> : '⇄'} {strings.delivery.switchButton}
                </button>
                <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4, marginTop: -2 }}>{strings.delivery.switchWhat}</div>
              </>
            )}
            {/* Shipping is GitHub's pull request, its checks and a merge the person confirms. */}
            <ShipSection runId={runId} button={primaryButton} onState={onShipState} />
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 4, fontSize: 12, color: theme.dim }}>
              <label htmlFor={`branch-name-${runId}`}>{strings.delivery.branchName}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id={`branch-name-${runId}`}
                  value={branchName}
                  placeholder={strings.delivery.branchPlaceholder}
                  disabled={busy !== null || suggesting}
                  spellCheck={false}
                  onChange={e => setBranchName(e.target.value)}
                  style={{ flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, padding: '7px 8px', background: '#0b0e14', color: '#d6dce6', border: `1px solid ${theme.border}`, borderRadius: 6, minWidth: 0 }}
                />
                <button
                  type="button"
                  disabled={busy !== null || suggesting}
                  onClick={() => void suggestName()}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.card, color: '#d6dce6', fontSize: 12, fontWeight: 600, cursor: suggesting ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
                >
                  {suggesting ? <WorkingSpinner blockId="suggest" size={12} /> : <SparkIcon />} {suggesting ? strings.delivery.suggesting : strings.delivery.suggestName}
                </button>
              </div>
              <span style={{ fontSize: 11, lineHeight: 1.4 }}>{strings.delivery.branchNameHint}</span>
            </div>
            <button
              type="button"
              disabled={busy !== null || suggesting}
              onClick={() => void bring('branch')}
              style={{ padding: '9px 12px', borderRadius: 8, border: `1px solid ${theme.passed}`, background: theme.passed, color: '#07110a', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              {busy === 'branch' ? <WorkingSpinner blockId="keep" size={16} /> : '⑂'} {strings.delivery.keepButton}
            </button>
            <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4, marginTop: -2 }}>{strings.delivery.keepWhat}</div>
          </>
        )}
        {delivery.delivered && <div style={{ fontSize: 12.5, color: '#b9dcc5', lineHeight: 1.4 }}>{strings.delivery.done(delivery.files.length)}</div>}
        {/* The less common moves, together behind one toggle, each in its own small card. Copying the change into what
            is open is not offered on the kept branch (it is already there); pushing alone only before anything was sent. */}
        {(() => {
          const canApply = !delivery.delivered && !(delivery.kept && delivery.current === delivery.branch)
          const canPushOnly = delivery.kept && !delivery.pushed
          if (!canApply && !canPushOnly) return null
          return (
            <div style={{ display: 'grid', gap: 8 }}>
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(o => !o)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.card, color: '#d6dce6', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                {strings.delivery.moreOptions}
                <span aria-hidden="true" style={{ transform: moreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease-out' }}>
                  ▾
                </span>
              </button>
              {moreOpen && (
                <div data-testid="more-options" style={{ display: 'grid', gap: 8 }}>
                  {canPushOnly && (
                    <div style={optionCard}>
                      <button type="button" disabled={busy !== null} onClick={() => void bring('push')} style={secondaryButton(busy)}>
                        {busy === 'push' ? <WorkingSpinner blockId="push" size={16} /> : '↑'} {strings.delivery.pushOnly}
                      </button>
                      <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4 }}>{strings.delivery.pushOnlyWhat}</div>
                    </div>
                  )}
                  {canApply && (
                    <div style={optionCard}>
                      <button type="button" disabled={busy !== null} onClick={() => void bring('apply')} style={secondaryButton(busy)}>
                        {busy === 'apply' ? <WorkingSpinner blockId="apply" size={16} /> : '⤵'} {strings.delivery.applyButton}
                      </button>
                      <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4 }}>{strings.delivery.applyWhat}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)', paddingTop: 10, borderTop: `1px solid ${theme.lineSoft}` }}>
        <div style={{ fontSize: 12, color: theme.dim }}>{strings.followUp.hint}</div>
        {composer}
        <button
          type="button"
          disabled={busy !== null || imagesBusy || note.trim() === ''}
          onClick={() => void followUp()}
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${theme.running}`,
            background: note.trim() ? theme.tint('running', 0.16) : 'transparent',
            color: note.trim() ? '#cfe0ff' : theme.skipped,
            fontWeight: 700,
            cursor: busy !== null || note.trim() === '' ? 'not-allowed' : 'pointer',
          }}
        >
          ↺ {busy === 'follow' ? strings.followUp.starting : strings.followUp.start}
        </button>
      </div>

      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: theme.failed, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </>
  )
}

const optionCard: CSSProperties = { display: 'grid', gap: 6, padding: 10, borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0f141c' }

function primaryButton(busy: unknown): CSSProperties {
  return { padding: '9px 12px', borderRadius: 8, border: `1px solid ${theme.passed}`, background: theme.passed, color: '#07110a', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }
}

function secondaryButton(busy: unknown): CSSProperties {
  return { padding: '8px 12px', borderRadius: 8, border: `1px solid ${theme.tint('passed', 0.6)}`, background: 'transparent', color: '#b9dcc5', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }
}

/** A small spark: "let the app suggest one". */
function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6 8 1.5Z" />
    </svg>
  )
}

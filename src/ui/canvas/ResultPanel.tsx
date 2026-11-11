'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { Delivery } from '@/engine/delivery'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'

/**
 * A finished, approved run: where its change is, how to bring it into the project, and how to ask for another change
 * on top of it. Bringing it over writes into the person's folder, so the button says exactly what it will do.
 */
export function ResultSection({
  runId,
  note,
  imageIds,
  imagesBusy,
  composer,
  onFollowUp,
}: {
  runId: string
  /** The shared composer's text: what to change next, on top of this approved change. */
  note: string
  imageIds: string[]
  imagesBusy: boolean
  composer: ReactNode
  onFollowUp: (runId: string) => void
}) {
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [busy, setBusy] = useState<'bring' | 'follow' | null>(null)
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

  async function bring() {
    setBusy('bring')
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/delivery`, { method: 'POST' })
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
          <div style={{ fontSize: 12.5, color: '#b9dcc5' }}>{delivery.delivered ? strings.delivery.done(delivery.files.length) : strings.delivery.ready}</div>
        </div>
      </div>

      {delivery.delivered ? (
        delivery.branch &&
        delivery.commit && <div style={{ fontSize: 12, color: theme.dim, lineHeight: 1.4 }}>{strings.delivery.keptOn(delivery.branch, delivery.commit)}</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void bring()}
            style={{ padding: '9px 12px', borderRadius: 8, border: `1px solid ${theme.passed}`, background: theme.passed, color: '#07110a', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
          >
            {busy === 'bring' ? <WorkingSpinner blockId="bring" size={16} /> : '⤵'} {busy === 'bring' ? strings.delivery.bringing : strings.delivery.bring}
          </button>
          <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4 }}>{strings.delivery.what}</div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 6, paddingTop: 10, borderTop: `1px solid ${theme.lineSoft}` }}>
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

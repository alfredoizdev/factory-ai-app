'use client'

import { useEffect, useState } from 'react'
import type { PreviewState } from '@/engine/preview'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

const POLL_MS = 1000

/**
 * Starts the project from the agent's copy and offers it in a new tab, so the change can be looked at, not just read.
 * Polls while it installs and starts; says plainly when it did not start, with what the project printed.
 */
export function PreviewButton({ runId }: { runId: string }) {
  const [state, setState] = useState<PreviewState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  const busy = state?.status === 'installing' || state?.status === 'starting'

  // Picks up a preview that is already running (after a reload), and follows one that is starting.
  useEffect(() => {
    let live = true
    const read = () =>
      fetch(`/api/runs/${runId}/preview`)
        .then(r => r.json() as Promise<PreviewState>)
        .then(s => live && setState(s))
        .catch(() => undefined)
    void read()
    if (!busy) return () => void (live = false)
    const timer = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [runId, busy])

  async function call(method: 'POST' | 'DELETE') {
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/preview`, { method })
      const body = (await res.json().catch(() => null)) as (PreviewState & { error?: string }) | null
      if (!res.ok || !body) return setError(body?.error ?? strings.preview.failed)
      setState(body)
    } catch {
      setError(strings.preview.failed)
    }
  }

  const status = state?.status ?? 'stopped'
  const line =
    status === 'installing' ? strings.preview.installing : status === 'starting' ? strings.preview.starting : status === 'ready' ? strings.preview.ready : null

  return (
    <div data-testid="preview" data-status={status} style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {status === 'ready' && state?.url ? (
          <>
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              style={{ padding: '7px 14px', borderRadius: 8, background: theme.running, color: '#fff', fontWeight: 700, textDecoration: 'none', fontSize: 13 }}
            >
              ↗ {strings.preview.open}
            </a>
            <button type="button" onClick={() => void call('DELETE')} style={{ background: 'none', border: 'none', color: theme.dim, cursor: 'pointer', fontSize: 12.5 }}>
              {strings.preview.stop}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void call('POST')}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              border: `1px solid ${theme.running}`,
              background: theme.tint('running', 0.12),
              color: '#cfe0ff',
              fontWeight: 700,
              fontSize: 13,
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            ▶ {strings.preview.start}
          </button>
        )}
        {line && <span style={{ fontSize: 12, color: status === 'ready' ? theme.dim : '#cfe0ff' }}>{line}</span>}
      </div>
      {(status === 'failed' || error) && (
        <div role="alert" style={{ fontSize: 12.5, color: theme.failed }}>
          {error ?? state?.message ?? strings.preview.failed}{' '}
          {state?.log && (
            <button type="button" onClick={() => setShowLog(v => !v)} style={{ background: 'none', border: 'none', color: theme.running, cursor: 'pointer', padding: 0, fontSize: 12.5 }}>
              {strings.preview.showLog}
            </button>
          )}
        </div>
      )}
      {showLog && state?.log && (
        <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto', background: '#0b0e14', border: `1px solid ${theme.border}`, borderRadius: 8, padding: 10, fontSize: 11.5, color: '#9aa5b6', whiteSpace: 'pre-wrap' }}>
          {state.log}
        </pre>
      )}
    </div>
  )
}

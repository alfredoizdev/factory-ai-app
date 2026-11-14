'use client'

import { useEffect, useRef, useState } from 'react'
import type { PreviewState } from '@/engine/preview'
import { brand } from '@/ui/brand'
import { strings } from '@/ui/strings'
import { WorkingSpinner } from './BlockCard'

const POLL_MS = 1000
const d = strings.direct

/**
 * Direct edit's other half: the project's own site, started from the task's copy, inside the screen. It starts by
 * itself, and the page updates as the files change. Before there is a task it says what will show here.
 */
export function LiveSite({ runId }: { runId: string | null }) {
  const [state, setState] = useState<PreviewState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Changing it reloads the frame: for a page that did not pick up a change by itself.
  const [turn, setTurn] = useState(0)
  const asked = useRef<string | null>(null)

  const status = state?.status ?? null
  const waiting = status === null || status === 'installing' || status === 'starting'

  const start = (id: string) =>
    fetch(`/api/runs/${id}/preview`, { method: 'POST' })
      .then(async r => {
        const body = (await r.json().catch(() => null)) as (PreviewState & { error?: string }) | null
        if (!r.ok || !body) setError(body?.error ?? strings.preview.failed)
        else {
          setError(null)
          setState(body)
        }
      })
      .catch(() => setError(strings.preview.failed))

  // Reads where the site stands; the first time it finds it stopped, starts it. Follows it while it starts.
  useEffect(() => {
    if (!runId || error) return
    let live = true
    const read = () =>
      fetch(`/api/runs/${runId}/preview`)
        .then(r => r.json() as Promise<PreviewState>)
        .then(s => {
          if (!live) return
          if (s.status === 'stopped' && asked.current !== runId) {
            asked.current = runId
            void start(runId)
          } else setState(s)
        })
        .catch(() => undefined)
    void read()
    if (!waiting) return () => void (live = false)
    const timer = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [runId, waiting, error])

  const centre = { height: '100%', display: 'grid', placeItems: 'center', padding: 32, textAlign: 'center' as const }
  const again = runId && (
    <button type="button" onClick={() => { setError(null); setState(null); asked.current = runId; void start(runId) }} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: brand.green, color: brand.onGreen, fontWeight: 700, cursor: 'pointer', font: 'inherit' }}>
      {d.tryAgain}
    </button>
  )
  let body
  if (!runId) {
    body = (
      <div style={centre}>
        <div style={{ display: 'grid', gap: 10, maxWidth: '44ch' }}>
          <strong style={{ fontSize: 19 }}>{d.emptyTitle}</strong>
          <span style={{ color: brand.quiet, lineHeight: 1.55 }}>{d.emptyText}</span>
        </div>
      </div>
    )
  } else if (error || status === 'failed' || status === 'stopped') {
    body = (
      <div style={centre}>
        <div role="alert" style={{ display: 'grid', gap: 12, justifyItems: 'center', maxWidth: '52ch' }}>
          <strong style={{ fontSize: 17 }}>{status === 'stopped' && !error ? d.stopped : d.failed}</strong>
          <span style={{ color: brand.quiet, lineHeight: 1.55 }}>{error ?? state?.message ?? ''}</span>
          {again}
          {state?.log && (
            <details style={{ width: '100%', textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', color: brand.quiet, fontSize: 13 }}>{strings.preview.showLog}</summary>
              <pre style={{ margin: '8px 0 0', maxHeight: 200, overflow: 'auto', padding: 10, borderRadius: 8, border: `1px solid ${brand.line}`, background: brand.card, color: brand.quiet, fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{state.log}</pre>
            </details>
          )}
        </div>
      </div>
    )
  } else if (status === 'ready' && state?.url) {
    body = <iframe key={turn} data-testid="live-site-frame" title={d.frameTitle} src={state.url} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />
  } else {
    body = (
      <div style={centre}>
        <div role="status" style={{ display: 'grid', gap: 12, justifyItems: 'center', color: brand.quiet }}>
          <WorkingSpinner blockId="live-site" size={26} />
          <span>{status === 'installing' ? strings.preview.installing : d.starting}</span>
        </div>
      </div>
    )
  }
  const ready = status === 'ready' && state?.url
  return (
    <section data-testid="live-site" data-status={status ?? 'none'} aria-label={d.title} style={{ height: '100%', display: 'flex', flexDirection: 'column', background: brand.bg, color: brand.text, fontFamily: brand.sans, borderLeft: `1px solid ${brand.line}` }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${brand.line}`, fontSize: 13 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: ready ? brand.green : brand.faint }} />
        <strong>{d.title}</strong>
        <span style={{ color: brand.quiet, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ready ? d.live : ''}</span>
        {ready && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, flex: 'none' }}>
            <button type="button" onClick={() => setTurn(t => t + 1)} style={{ background: 'none', border: 'none', padding: 0, color: brand.quiet, cursor: 'pointer', font: 'inherit' }}>{d.reload}</button>
            <a href={state!.url!} target="_blank" rel="noreferrer" style={{ color: brand.quiet }}>{d.newTab} ↗</a>
          </span>
        )}
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>{body}</div>
    </section>
  )
}

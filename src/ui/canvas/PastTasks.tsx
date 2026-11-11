'use client'

import { useEffect, useState } from 'react'
import type { RunSummary } from '@/engine/run'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'

type Status = keyof typeof strings.run.status
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
}: {
  workflowId: string
  currentRunId: string | null
  /** Changes when the list may be stale: a run started or finished. */
  refreshKey: string
  onOpen: (runId: string) => void
  /** Called once a task is deleted, with its id: the screen leaves it if it was the one open. */
  onDeleted?: (runId: string) => void
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  useEffect(() => {
    let live = true
    fetch(`/api/workflows/${workflowId}/runs`)
      .then(r => (r.ok ? (r.json() as Promise<{ runs: RunSummary[] }>) : null))
      .then(d => live && d && setRuns(d.runs))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [workflowId, refreshKey])

  if (runs === null) return null
  if (runs.length === 0) return <p style={{ margin: 0, fontSize: 12.5, color: theme.skipped }}>{strings.history.empty}</p>
  return (
    <>
    {error && (
      <p role="alert" style={{ margin: '0 0 6px', fontSize: 12, color: theme.failed }}>
        {error}
      </p>
    )}
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
      {runs.map(r => {
        const current = r.runId === currentRunId
        const status = (r.status in strings.run.status ? r.status : 'queued') as Status
        return (
          <li
            key={r.runId}
            // The item is its own card: the task, its bin, and, when asked, the confirmation inside it, underneath.
            style={{
              position: 'relative',
              borderRadius: 8,
              border: `1px solid ${confirming === r.runId ? theme.tint('failed', 0.5) : current ? theme.tint('running', 0.5) : 'transparent'}`,
              background: confirming === r.runId ? theme.tint('failed', 0.06) : current ? theme.tint('running', 0.12) : 'transparent',
            }}
          >
            <button
              type="button"
              aria-label={strings.history.delete(r.request)}
              title={strings.history.delete(r.request)}
              onClick={() => setConfirming(c => (c === r.runId ? null : r.runId))}
              style={{ position: 'absolute', right: 6, top: 30, width: 22, height: 22, display: 'grid', placeItems: 'center', padding: 0, background: 'none', border: 'none', color: confirming === r.runId ? theme.failed : theme.skipped, cursor: 'pointer', zIndex: 1 }}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" />
              </svg>
            </button>
            <button
              type="button"
              data-testid={`past-task-${r.runId}`}
              aria-current={current ? 'true' : undefined}
              onClick={() => onOpen(r.runId)}
              style={{
                width: '100%',
                textAlign: 'left',
                display: 'grid',
                gap: 3,
                padding: '7px 30px 7px 9px',
                background: 'transparent',
                border: 'none',
                borderRadius: 8,
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 12.5, lineHeight: 1.35, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {r.parentRunId ? '↺ ' : ''}
                {r.request}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: theme.dim }}>
                <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: COLOUR[status] ?? theme.skipped }} />
                {strings.run.status[status]}
                <span>·</span>
                {whenText(r.createdAt)}
                {r.providerId === DEMO_PROVIDER_ID && <span style={{ color: theme.waiting }}>· {strings.history.demo}</span>}
              </span>
            </button>
            {confirming === r.runId && (
              // Asked on the spot, inside this task's own card, never by a browser dialog: deleting cannot be undone.
              <div role="group" aria-label={strings.history.confirm} style={{ display: 'grid', gap: 6, padding: '8px 9px 9px', borderTop: `1px solid ${theme.tint('failed', 0.3)}`, fontSize: 11.5, lineHeight: 1.4 }}>
                {strings.history.confirm}
                <span style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    disabled={deleting !== null}
                    onClick={() => void remove(r.runId)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, border: `1px solid ${theme.failed}`, background: theme.failed, color: '#fff', fontWeight: 700, cursor: deleting ? 'wait' : 'pointer', opacity: deleting && deleting !== r.runId ? 0.6 : 1 }}
                  >
                    {deleting === r.runId && <WorkingSpinner blockId={`delete-${r.runId}`} size={12} />}
                    {deleting === r.runId ? strings.history.deleting : strings.history.yes}
                  </button>
                  <button type="button" disabled={deleting !== null} onClick={() => setConfirming(null)} style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: `1px solid ${theme.border}`, background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
                    {strings.history.no}
                  </button>
                </span>
              </div>
            )}
          </li>
        )
      })}
    </ul>
    </>
  )
}

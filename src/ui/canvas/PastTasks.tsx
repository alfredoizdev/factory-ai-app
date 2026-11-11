'use client'

import { useEffect, useState } from 'react'
import type { RunSummary } from '@/engine/run'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

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
}: {
  workflowId: string
  currentRunId: string | null
  /** Changes when the list may be stale: a run started or finished. */
  refreshKey: string
  onOpen: (runId: string) => void
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
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
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
      {runs.map(r => {
        const current = r.runId === currentRunId
        const status = (r.status in strings.run.status ? r.status : 'queued') as Status
        return (
          <li key={r.runId}>
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
                padding: '7px 9px',
                background: current ? theme.tint('running', 0.12) : 'transparent',
                border: `1px solid ${current ? theme.tint('running', 0.5) : 'transparent'}`,
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
          </li>
        )
      })}
    </ul>
  )
}

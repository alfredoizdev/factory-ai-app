'use client'

import { useRef, useState } from 'react'
import type { Block, Graph, ValidationIssue } from '@/domain/graph'
import type { ProjectSettings } from '@/engine/project-settings'
import { CLAUDE_PROVIDER_ID, DEMO_PROVIDER_ID } from '@/providers/ids'
import { EventBarList } from '@/ui/EventBar'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { AgentSettings } from './AgentSettings'
import { Canvas } from './Canvas'
import { useRunStream, type RunStatus } from './useRunStream'

/** The run being watched. `blocks` are the frozen version it executes, not the draft. */
export type RunInfo = { runId: string; providerId: string; blocks: Block[] }

const LIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'waiting_approval'])

const headerButton = {
  padding: '6px 14px',
  background: theme.card,
  color: 'inherit',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  cursor: 'pointer',
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : fallback
}

type Agent = typeof DEMO_PROVIDER_ID | typeof CLAUDE_PROVIDER_ID

export function CanvasScreen({
  workflowId,
  graph,
  run: initialRun = null,
  settings: initialSettings = null,
}: {
  workflowId: string
  graph: Graph
  run?: RunInfo | null
  /** The project's repository settings. Absent: the agent switch is not offered and every run is the demo. */
  settings?: ProjectSettings | null
}) {
  const [run, setRun] = useState<RunInfo | null>(initialRun)
  const [settings, setSettings] = useState<ProjectSettings | null>(initialSettings)
  // The demo is the default every time the page opens: a real agent is always chosen on purpose.
  const [agent, setAgent] = useState<Agent>(DEMO_PROVIDER_ID)
  const claudeBlocked = agent === CLAUDE_PROVIDER_ID && !settings?.repoPath
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const flushRef = useRef<(() => Promise<boolean>) | null>(null)

  // The blocks are always passed: without them the hook cannot say what a block did in its own words.
  const { views, events, runStatus, connected } = useRunStream(run?.runId ?? null, run?.blocks)

  // keepalive lets a save started as the page closes still complete.
  async function save(next: Graph): Promise<ValidationIssue[]> {
    const res = await fetch(`/api/workflows/${workflowId}/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
      keepalive: true,
    })
    if (!res.ok) throw new Error(`Saving the draft failed (${res.status})`)
    return ((await res.json()) as { issues: ValidationIssue[] }).issues
  }

  async function startRun() {
    setBusy(true)
    setMessage(null)
    try {
      if (flushRef.current && !(await flushRef.current())) return setMessage(strings.run.saveFirst)
      const published = await fetch(`/api/workflows/${workflowId}/publish`, { method: 'POST' })
      if (!published.ok) return setMessage(published.status === 400 ? strings.run.fixFirst : await readError(published, strings.run.startFailed))
      const created = await fetch(`/api/workflows/${workflowId}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, provider: agent }),
      })
      if (!created.ok) return setMessage(await readError(created, strings.run.startFailed))
      const { runId } = (await created.json()) as { runId: string }
      const detail = await fetch(`/api/runs/${runId}`)
      if (!detail.ok) return setMessage(await readError(detail, strings.run.startFailed))
      setHighlightedId(null)
      setRun((await detail.json()) as RunInfo)
    } catch {
      setMessage(strings.run.startFailed)
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    if (!run) return
    setMessage(null)
    try {
      const res = await fetch(`/api/runs/${run.runId}/cancel`, { method: 'POST' })
      if (!res.ok) setMessage(await readError(res, strings.run.cancelFailed))
    } catch {
      setMessage(strings.run.cancelFailed)
    }
  }

  const live = runStatus !== null && LIVE.has(runStatus)
  const statusText = run === null ? null : runStatus !== null ? strings.run.status[runStatus] : connected ? null : strings.run.connecting

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, background: theme.bg }}>
        <input
          aria-label={strings.run.requestLabel}
          placeholder={strings.run.requestPlaceholder}
          value={request}
          onChange={e => setRequest(e.target.value)}
          style={{ flex: 1, maxWidth: 480, padding: '6px 10px', background: theme.card, color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 6 }}
        />
        {settings && (
          <select
            aria-label={strings.settings.agentLabel}
            value={agent}
            onChange={e => setAgent(e.target.value as Agent)}
            disabled={live}
            style={{ ...headerButton, padding: '6px 10px' }}
          >
            <option value={DEMO_PROVIDER_ID}>{strings.settings.agentDemo}</option>
            <option value={CLAUDE_PROVIDER_ID}>{strings.settings.agentClaude}</option>
          </select>
        )}
        <button
          type="button"
          style={headerButton}
          disabled={busy || live || request.trim() === '' || claudeBlocked}
          title={claudeBlocked ? strings.settings.needsRepo : undefined}
          onClick={startRun}
        >
          {busy ? strings.run.starting : strings.run.run}
        </button>
        <button type="button" style={headerButton} disabled={!live} onClick={cancel}>
          {strings.run.cancel}
        </button>
        {run?.providerId === DEMO_PROVIDER_ID && (
          <span
            title={strings.run.demoTitle}
            style={{ padding: '2px 8px', border: `1px solid ${theme.waiting}`, color: theme.waiting, borderRadius: 999, fontSize: 12, fontWeight: 600 }}
          >
            {strings.run.demoBadge}
          </span>
        )}
        {statusText && (
          <span data-testid="run-status" role="status" style={{ color: runStatus ? theme[statusColour(runStatus)] : theme.skipped, fontSize: 13 }}>
            {statusText}
          </span>
        )}
        {message && (
          <span role="alert" style={{ color: theme.failed, fontSize: 13 }}>
            {message}
          </span>
        )}
      </header>
      {settings && agent === CLAUDE_PROVIDER_ID && <AgentSettings settings={settings} onSaved={setSettings} />}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Canvas
          graph={graph}
          save={save}
          nodeRuns={Object.values(views)}
          runBlocks={run?.blocks}
          highlightedId={highlightedId}
          flushRef={flushRef}
        />
      </div>
      {run && <EventBarList events={events} blocks={run.blocks} onPoint={setHighlightedId} />}
    </div>
  )
}

function statusColour(status: RunStatus): 'running' | 'passed' | 'failed' | 'waiting' | 'skipped' {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'passed'
  if (status === 'failed') return 'failed'
  if (status === 'waiting_approval') return 'waiting'
  return 'skipped'
}

'use client'

import { useRef, useState } from 'react'
import type { Block, Graph, ValidationIssue } from '@/domain/graph'
import type { ProjectSettings } from '@/engine/project-settings'
import { CLAUDE_PROVIDER_ID, DEMO_PROVIDER_ID } from '@/providers/ids'
import { EventBarList } from '@/ui/EventBar'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { AgentSettings } from './AgentSettings'
import { Canvas, RUN_INPUT_ID } from './Canvas'
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

  const canRun = !busy && !live && request.trim() !== '' && !claudeBlocked

  // Where a run is asked for. It lives at the top of the sidebar, with room to write a real request.
  const runPanel = (
    <>
      <h2 style={{ margin: 0, fontSize: 14 }}>{strings.sidebar.runTitle}</h2>
      <textarea
        id={RUN_INPUT_ID}
        aria-label={strings.run.requestLabel}
        placeholder={strings.run.requestPlaceholder}
        value={request}
        rows={6}
        onChange={e => setRequest(e.target.value)}
        onKeyDown={e => {
          // Cmd+Enter (Ctrl+Enter elsewhere) runs, so a long request does not need the mouse.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) {
            e.preventDefault()
            void startRun()
          }
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          minHeight: 110,
          padding: '10px 12px',
          background: theme.card,
          color: 'inherit',
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          font: 'inherit',
          fontSize: 14,
          lineHeight: 1.45,
        }}
      />
      {settings && (
        <label style={{ display: 'grid', gap: 4, fontSize: 12.5, color: theme.dim }}>
          {strings.settings.agentLabel}
          <select
            aria-label={strings.settings.agentLabel}
            value={agent}
            onChange={e => setAgent(e.target.value as Agent)}
            disabled={live}
            style={{ ...headerButton, width: '100%', padding: '7px 10px', textAlign: 'left' }}
          >
            <option value={DEMO_PROVIDER_ID}>{strings.settings.agentDemo}</option>
            <option value={CLAUDE_PROVIDER_ID}>{strings.settings.agentClaude}</option>
          </select>
        </label>
      )}
      {settings && agent === CLAUDE_PROVIDER_ID && <AgentSettings settings={settings} onSaved={setSettings} />}
      <button
        type="button"
        disabled={!canRun}
        title={claudeBlocked ? strings.settings.needsRepo : undefined}
        onClick={startRun}
        style={{
          ...headerButton,
          width: '100%',
          padding: '9px 14px',
          fontWeight: 600,
          background: canRun ? theme.running : theme.card,
          borderColor: canRun ? theme.running : theme.border,
          color: canRun ? '#fff' : theme.skipped,
          cursor: canRun ? 'pointer' : 'not-allowed',
        }}
      >
        {busy ? strings.run.starting : strings.run.run}
      </button>
      <span style={{ fontSize: 11.5, color: theme.skipped, textAlign: 'center' }}>{strings.sidebar.runShortcut}</span>
      {claudeBlocked && <span style={{ fontSize: 12.5, color: theme.waiting }}>{strings.settings.needsRepo}</span>}
      {message && (
        <span role="alert" style={{ color: theme.failed, fontSize: 13 }}>
          {message}
        </span>
      )}
    </>
  )

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* A thin bar for what must stay visible with the sidebar closed: the run's state, and the way to stop it. */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', minHeight: 36, borderBottom: `1px solid ${theme.border}`, background: theme.bg }}>
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
        <button type="button" style={{ ...headerButton, marginLeft: 'auto' }} disabled={!live} onClick={cancel}>
          {strings.run.cancel}
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Canvas
          graph={graph}
          save={save}
          nodeRuns={Object.values(views)}
          runBlocks={run?.blocks}
          highlightedId={highlightedId}
          flushRef={flushRef}
          sidebarTop={runPanel}
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

'use client'

import { PastTasks } from './PastTasks'
import { TasksDrawer } from './TasksDrawer'
import { TaskTitle } from './TaskTitle'
import { ProjectSwitcher } from './ProjectSwitcher'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { SettingsIcon } from './SettingsIcon'
import { shipView } from './shipView'
import type { ShipState } from '@/engine/ship'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Block, Graph, ValidationIssue } from '@/domain/graph'
import type { ProjectSettings } from '@/engine/project-settings'
import { CLAUDE_PROVIDER_ID, DEMO_PROVIDER_ID } from '@/providers/ids'
import { EventBarList } from '@/ui/EventBar'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'
import { CommandCard, type CardMode } from './CommandCard'
import { imagesBusy, readyImageIds, type ComposerImage } from './Composer'
import { Canvas, RUN_INPUT_ID } from './Canvas'
import { useRunStream, type RunStatus } from './useRunStream'

/** The run being watched. `blocks` are the frozen version it executes, not the draft. */
export type RunInfo = { runId: string; providerId: string; blocks: Block[]; title?: string }

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
  draftUpdatedAt,
}: {
  workflowId: string
  graph: Graph
  run?: RunInfo | null
  /** The project's repository settings. Absent: the agent switch is not offered and every run is the demo. */
  settings?: ProjectSettings | null
  /** The draft's version as the page loaded it; saves are refused once someone else has saved a newer one. */
  draftUpdatedAt?: string
}) {
  const [run, setRun] = useState<RunInfo | null>(initialRun)
  const [settings, setSettings] = useState<ProjectSettings | null>(initialSettings)
  // The demo is the default every time the page opens: a real agent is always chosen on purpose.
  // A project with a folder is worked on by Claude by default; without one only the demo can run.
  const [agent, setAgent] = useState<Agent>(initialSettings?.repoPath ? CLAUDE_PROVIDER_ID : DEMO_PROVIDER_ID)
  const claudeBlocked = agent === CLAUDE_PROVIDER_ID && !settings?.repoPath
  const [request, setRequest] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  // The name the person gives a new task, if any; empty, the app names it from the request.
  const [taskName, setTaskName] = useState('')
  const clearComposer = () => {
    setRequest('')
    setImages(prev => {
      for (const i of prev) URL.revokeObjectURL(i.previewUrl)
      return []
    })
  }
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const flushRef = useRef<(() => Promise<boolean>) | null>(null)
  const cardRef = useRef<HTMLElement | null>(null)

  // A follow-up is a new run: the canvas switches to watching it, the same way a new run started from the sidebar does.
  async function watchRun(runId: string) {
    const detail = await fetch(`/api/runs/${runId}`)
    if (!detail.ok) return setMessage(await readError(detail, strings.run.startFailed))
    setHighlightedId(null)
    setRun((await detail.json()) as RunInfo)
  }

  // The blocks are always passed: without them the hook cannot say what a block did in its own words.
  const { views, events, runStatus, connected, loaded } = useRunStream(run?.runId ?? null, run?.blocks)

  // Saves go one at a time, each naming the draft version it builds on, so a page left open from earlier can never
  // overwrite a newer flow: the server refuses, and the page says to reload. keepalive lets a save started as the
  // page closes still complete.
  const draftBase = useRef<string | undefined>(draftUpdatedAt)
  const saveChain = useRef<Promise<unknown>>(Promise.resolve())
  const stale = useRef(false)
  function save(next: Graph): Promise<ValidationIssue[]> {
    const attempt = saveChain.current.catch(() => undefined).then(async () => {
      if (stale.current) throw new Error('stale draft')
      const res = await fetch(`/api/workflows/${workflowId}/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(draftBase.current ? { 'x-draft-base': draftBase.current } : {}) },
        body: JSON.stringify(next),
        keepalive: true,
      })
      if (res.status === 409) {
        stale.current = true
        setMessage(strings.editing.staleDraft)
        throw new Error('stale draft')
      }
      if (!res.ok) throw new Error(`Saving the draft failed (${res.status})`)
      const body = (await res.json()) as { issues: ValidationIssue[]; updatedAt?: string }
      if (body.updatedAt) draftBase.current = body.updatedAt
      return body.issues
    })
    saveChain.current = attempt
    return attempt
  }

  // A fresh task starts from the project's main branch, whatever branch the folder is on; when the folder is on
  // another one, the card offers that one too. Nothing about the folder has to change first.
  const [startFrom, setStartFrom] = useState<string | null>(null)
  const startOptions = [...new Set([settings?.defaultBranch, settings?.currentBranch].filter((b): b is string => !!b))]
  const chosenStart = startFrom !== null && startOptions.includes(startFrom) ? startFrom : (startOptions[0] ?? null)

  const [tasksOpen, setTasksOpen] = useState(false)
  // What GitHub says about shipping this run, as the result card last read it; the Ship card shows the same thing.
  const [shipFor, setShipFor] = useState<{ runId: string; state: ShipState } | null>(null)
  const runIdNow = run?.runId ?? null
  const setShip = useCallback((state: ShipState) => runIdNow && setShipFor({ runId: runIdNow, state }), [runIdNow])
  const shipBlock = run?.blocks.find(b => b.kind === 'ship')

  // A task is shown whole: once its events are all in and, when it went to GitHub, once GitHub said where it stands
  // (the Ship card would otherwise change its words a moment later). Then a moment more for its cards to settle.
  const [shownFor, setShownFor] = useState<string | null>(null)
  const wentToGitHub = events.some(e => e.type === 'run.pr_opened')
  const shipKnown = shipFor?.runId === runIdNow
  useEffect(() => {
    if (!loaded || !runIdNow || !wentToGitHub || shipKnown) return
    let live = true
    fetch(`/api/runs/${runIdNow}/ship`)
      .then(r => (r.ok ? (r.json() as Promise<ShipState>) : null))
      .then(state => live && state && setShipFor({ runId: runIdNow, state }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [loaded, runIdNow, wentToGitHub, shipKnown])
  const ready = loaded && (!wentToGitHub || shipKnown)
  useEffect(() => {
    if (!loaded || !runIdNow) return
    // Never stuck: GitHub may be slow or unreachable; the task is shown anyway after a few seconds.
    const t = setTimeout(() => setShownFor(runIdNow), ready ? 250 : 4000)
    return () => clearTimeout(t)
  }, [loaded, ready, runIdNow])
  const loading = !!run && shownFor !== run.runId
  const shipped = shipFor && shipFor.runId === runIdNow && shipBlock ? shipView(shipBlock.id, shipFor.state) : null
  const shippedViews = shipped && shipBlock ? { ...views, [shipBlock.id]: shipped } : views
  // Once the change reached the person (its risk was measured), the Ship card carries its before and after pictures.
  const reachedPerson = Object.values(views).some(v => v.risk)
  const withShip =
    reachedPerson && runIdNow && shipBlock && shippedViews[shipBlock.id] ? { ...shippedViews, [shipBlock.id]: { ...shippedViews[shipBlock.id]!, results: runIdNow } } : shippedViews
  const closeTasks = useCallback(() => setTasksOpen(false), [])

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
        body: JSON.stringify({
          request,
          provider: agent,
          attachments: readyImageIds(images),
          ...(taskName.trim() ? { title: taskName.trim() } : {}),
          ...(agent === CLAUDE_PROVIDER_ID && chosenStart ? { startFrom: chosenStart } : {}),
        }),
      })
      if (!created.ok) return setMessage(await readError(created, strings.run.startFailed))
      const { runId } = (await created.json()) as { runId: string }
      const detail = await fetch(`/api/runs/${runId}`)
      if (!detail.ok) return setMessage(await readError(detail, strings.run.startFailed))
      setHighlightedId(null)
      setRun((await detail.json()) as RunInfo)
      clearComposer()
      setTaskName('')
    } catch {
      setMessage(strings.run.startFailed)
    } finally {
      setBusy(false)
    }
  }

  // Leaves the finished run on screen behind and opens an empty task; the branch it will start from is read again,
  // since the person may have switched branches meanwhile.
  // Why no task is on screen: the person asked for a new one (then the screen helps them write it), or there is
  // simply nothing open (then it points at the past tasks too).
  const [emptyBecause, setEmptyBecause] = useState<'new' | 'none'>('none')

  function newTask(reason: 'new' | 'none' = 'new') {
    setEmptyBecause(reason)
    setRun(null)
    setStartFrom(null)
    setHighlightedId(null)
    setMessage(null)
    clearComposer()
    if (settings) {
      fetch(`/api/projects/${settings.projectId}`)
        .then(r => (r.ok ? (r.json() as Promise<ProjectSettings>) : null))
        .then(next => next && setSettings(next))
        .catch(() => undefined)
    }
    // A new task is written in the card: put the cursor there.
    if (reason === 'new') requestAnimationFrame(() => document.getElementById(RUN_INPUT_ID)?.focus())
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
  // A finished run's state is about the run on screen, not about what the buttons beside it will do: say so.
  const finished = runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled'
  const statusText =
    run === null
      ? null
      : runStatus !== null
        ? finished
          ? strings.run.lastRun(strings.run.status[runStatus])
          : strings.run.status[runStatus]
        : connected
          ? null
          : strings.run.connecting

  const canRun = !busy && !live && request.trim() !== '' && !claudeBlocked && !imagesBusy(images)

  // The sidebar keeps the agent's settings; what to ask for lives in the command card on the canvas.
  // The project's settings live with the project (its menu, and the gear beside it), not with a task.
  const [settingsOpen, setSettingsOpen] = useState(false)

  // One card follows the run: ask, watch, decide, continue.
  // The run waits on the person at its plan, or at the human check: the card shows the one it waits at.
  const planWaiting = !!run && run.blocks.some(b => b.kind === 'plan' && views[b.id]?.state === 'waiting_approval')
  const mode: CardMode =
    run && runStatus === 'waiting_approval' && planWaiting
      ? 'plan'
      : run && runStatus === 'waiting_approval'
      ? 'waiting'
      : run && (runStatus === 'running' || runStatus === 'queued')
        ? 'working'
        : run && runStatus === 'completed' && run.providerId !== DEMO_PROVIDER_ID
          ? 'done'
          : 'idle'

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* The controls stay in the top bar, visible with the sidebar closed: which agent, run, stop, and the run's state. */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', minHeight: 36, borderBottom: `1px solid ${theme.border}`, background: theme.bg }}>
        <ProjectSwitcher workflowId={workflowId} style={headerButton} onOpenSettings={settings ? () => setSettingsOpen(true) : undefined} />
        {settings && (
          <button type="button" aria-label={strings.projectSettings.open} title={strings.projectSettings.open} onClick={() => setSettingsOpen(true)} style={{ ...headerButton, padding: '6px 9px', display: 'grid', placeItems: 'center' }}>
            <SettingsIcon size={17} />
          </button>
        )}
        {settingsOpen && settings && <ProjectSettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} onSaved={setSettings} />}
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
          disabled={!canRun}
          title={claudeBlocked ? strings.settings.needsRepo : request.trim() === '' ? strings.run.writeFirst : undefined}
          onClick={startRun}
          style={{
            ...headerButton,
            fontWeight: 600,
            background: canRun ? theme.running : theme.card,
            borderColor: canRun ? theme.running : theme.border,
            color: canRun ? '#fff' : theme.skipped,
            cursor: canRun ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? strings.run.starting : strings.run.run}
        </button>
        {claudeBlocked && (
          <button type="button" onClick={() => setSettingsOpen(true)} style={{ background: 'none', border: 'none', padding: 0, fontSize: 12.5, color: theme.waiting, cursor: 'pointer', textDecoration: 'underline' }}>
            {strings.settings.needsRepo}
          </button>
        )}
        <button type="button" style={headerButton} disabled={!live} onClick={cancel}>
          {strings.run.cancel}
        </button>
        {/* A finished run stays on screen until the person moves on: this clears it for a separate, fresh task. */}
        {run && !live && (
          <button type="button" style={{ ...headerButton, fontWeight: 600 }} onClick={() => newTask('new')}>
            ＋ {strings.delivery.newTask}
          </button>
        )}
        {/* The buttons act; what follows describes the run on screen, so it sits apart, at the far end. */}
        <span aria-hidden="true" style={{ flex: 1 }} />
        {run?.providerId === DEMO_PROVIDER_ID && (
          <span
            title={strings.run.demoTitle}
            style={{ padding: '2px 8px', border: `1px solid ${theme.waiting}`, color: theme.waiting, borderRadius: 999, fontSize: 12, fontWeight: 600 }}
          >
            {strings.run.demoBadge}
          </span>
        )}
        {statusText && runStatus === 'waiting_approval' ? (
          // Waiting on the person: the status itself takes them to the decision.
          <button
            type="button"
            data-testid="run-status"
            title={strings.gate.goToGate}
            onClick={() => {
              const waiting = run?.blocks.find(b => views[b.id]?.state === 'waiting_approval')
              if (waiting) setHighlightedId(waiting.id)
              cardRef.current?.focus()
              cardRef.current?.scrollIntoView?.({ block: 'nearest' })
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              background: theme.tint('waiting', 0.12),
              color: theme.waiting,
              border: `1px solid ${theme.tint('waiting', 0.5)}`,
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true">⚠</span>
            {statusText}
          </button>
        ) : statusText && runStatus === 'completed' && run && run.providerId !== DEMO_PROVIDER_ID ? (
          // Finished: the status takes the person to the result, where the change can be brought over or continued.
          <button
            type="button"
            data-testid="run-status"
            title={strings.delivery.title}
            onClick={() => {
              cardRef.current?.focus()
              cardRef.current?.scrollIntoView?.({ block: 'nearest' })
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              background: theme.tint('passed', 0.12),
              color: theme.passed,
              border: `1px solid ${theme.tint('passed', 0.5)}`,
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true">✓</span>
            {statusText}
          </button>
        ) : (
          statusText && (
            <span
              data-testid="run-status"
              role="status"
              style={{ display: 'flex', alignItems: 'center', gap: 7, color: runStatus ? theme[statusColour(runStatus)] : theme.skipped, fontSize: 13 }}
            >
              {runStatus === 'running' && <WorkingSpinner blockId="run" size={14} />}
              {statusText}
            </span>
          )
        )}
      </header>
      {/* Clipped: the closed drawer waits just off the right edge, and must not make the page scroll. */}
      {/* clip, not hidden: a hidden box can still be scrolled by the browser (find in page, scrollIntoView), which would
          slide the whole canvas sideways to show the closed drawer. A clipped one cannot scroll at all. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'clip' }}>
        {/* Top right of the canvas, where the list it opens slides in from. */}
        <button
          type="button"
          aria-expanded={tasksOpen}
          onClick={() => setTasksOpen(o => !o)}
          style={{ ...headerButton, position: 'absolute', top: 12, right: 16, zIndex: 6, fontWeight: 600, background: theme.card, boxShadow: '0 6px 18px rgba(0,0,0,0.35)' }}
        >
          ☰ {strings.history.open}
        </button>
        {run === null && (
          // No task is open (a new one not started yet, or the open one was deleted): say so, and where to go next.
          // The flow below stays visible: it is what the next task will run through.
          <div
            data-testid="no-task"
            role="region"
            aria-label={strings.history.noTaskTitle}
            style={{
              position: 'absolute',
              top: 64,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 4,
              width: 'min(440px, calc(100% - 32px))',
              display: 'grid',
              gap: 8,
              padding: '16px 18px',
              background: theme.card,
              border: `1px solid ${theme.border}`,
              borderRadius: 12,
              boxShadow: '0 12px 30px rgba(0,0,0,0.4)',
              textAlign: 'center',
            }}
          >
            {emptyBecause === 'new' ? (
              <>
                <strong style={{ fontSize: 15 }}>{strings.history.newTaskTitle}</strong>
                <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>{strings.history.newTaskText}</span>
              </>
            ) : (
              <>
                <strong style={{ fontSize: 15 }}>{strings.history.noTaskTitle}</strong>
                <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>{strings.history.noTaskText}</span>
                <button type="button" onClick={() => setTasksOpen(true)} style={{ ...headerButton, justifySelf: 'center', fontWeight: 600 }}>
                  ☰ {strings.history.openPast}
                </button>
              </>
            )}
          </div>
        )}
        <TasksDrawer open={tasksOpen} onClose={closeTasks}>
          <PastTasks
            workflowId={workflowId}
            currentRunId={run?.runId ?? null}
            refreshKey={`${run?.runId ?? ''}-${runStatus ?? ''}-${tasksOpen}`}
            onOpen={id => {
              setTasksOpen(false)
              void watchRun(id)
            }}
            onDeleted={id => {
              // The open task is gone: leave it, and close the list so the "No task open" screen is seen.
              if (id === run?.runId) {
                newTask('none')
                setTasksOpen(false)
              }
            }}
          />
        </TasksDrawer>
        <CommandCard
          key={`${run?.runId ?? 'none'}-${loading ? 'loading' : mode}`}
          ref={cardRef}
          mode={mode}
          runId={run?.runId ?? null}
          risk={Object.values(views).find(v => v.state === 'waiting_approval')?.risk}
          text={request}
          onText={setRequest}
          images={images}
          onImages={setImages}
          onRun={() => void startRun()}
          canRun={canRun}
          onFollowUp={id => void watchRun(id)}
          onShipState={setShip}
          onSent={clearComposer}
          startOptions={agent === CLAUDE_PROVIDER_ID ? startOptions : []}
          startFrom={startFrom}
          onStartFrom={setStartFrom}
          taskName={taskName}
          onTaskName={setTaskName}
          loading={loading}
        />
        <Canvas
          graph={graph}
          save={save}
          nodeRuns={Object.values(withShip)}
          runBlocks={run?.blocks}
          highlightedId={highlightedId}
          flushRef={flushRef}
          loading={loading}
          overlay={run && !loading ? <TaskTitle key={run.runId} runId={run.runId} initial={run.title ?? ''} /> : undefined}
          sidebarLog={run ? <EventBarList events={events} blocks={run.blocks} onPoint={setHighlightedId} /> : undefined}
        />
      </div>
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

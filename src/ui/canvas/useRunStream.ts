'use client'

import { useEffect, useMemo, useReducer, useRef } from 'react'
import { canTransition, type NodeState } from '@/domain/states'
import { claimUsed, summarize, type SummaryInput } from '@/domain/summary'
import type { Block, BlockKind } from '@/domain/graph'
import type { EventRow } from '@/engine/events'
import { strings } from '@/ui/strings'
import type { NodeRunView } from '@/ui/canvas/BlockCard'

// Folds a run's event log into one NodeRunView per block. A view's state only ever comes from an event.

export const RECONNECT_DELAYS_MS = [1000, 2000, 5000] as const

const NODE_EVENT_STATE: Record<string, NodeState> = {
  'node.queued': 'queued',
  'node.started': 'running',
  'node.waiting_approval': 'waiting_approval',
  'node.completed': 'passed',
  'node.failed': 'failed',
  'node.skipped': 'skipped',
  'node.cancelled': 'cancelled',
}

type RawNode = { state: NodeState; steps: string[]; reportedSummary?: string; claimSource?: string; skippedReason?: string }
export type StreamState = { nodes: Record<string, RawNode>; lastSequence: number }
export const emptyStream: StreamState = { nodes: {}, lastSequence: 0 }

export type Wire = Pick<EventRow, 'sequence' | 'type' | 'payload'>

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

// Pure. Anything it does not recognise only advances the cursor, so an event type added later cannot corrupt a view.
export function foldEvent(prev: StreamState, event: Wire): StreamState {
  if (event.sequence <= prev.lastSequence) return prev // already applied: a replay overlap is not a second step
  const moved: StreamState = { nodes: prev.nodes, lastSequence: event.sequence }

  const payload = (event.payload ?? {}) as Record<string, unknown>
  const blockId = text(payload.blockId)
  if (blockId === undefined) return moved
  const node = prev.nodes[blockId]

  // node.step carries no state: it only extends the list of a block the log has already given a state.
  // A step for an unseen block would need an invented state, so only the cursor moves.
  if (event.type === 'node.step') {
    const step = text(payload.text)
    if (!node || step === undefined) return moved
    return { nodes: { ...prev.nodes, [blockId]: { ...node, steps: [...node.steps, step] } }, lastSequence: event.sequence }
  }

  const state = NODE_EVENT_STATE[event.type]
  if (state === undefined) return moved
  // First sight of a block takes whatever the log says (a run may lack node.queued). After that the state
  // machine decides: an event it forbids, such as a start after a finish, is not applied.
  // (The event is still real, but the view keeps the state the machine allows; the cursor moves so it is not retried.)
  if (node && node.state !== state && !canTransition(node.state, state)) return moved

  const updated: RawNode = { ...node, state, steps: node?.steps ?? [] }
  if (event.type === 'node.completed') {
    updated.reportedSummary = text(payload.summary)
    // Carry the producer's marker verbatim; summarize/claimUsed decide what it means.
    updated.claimSource = typeof payload.summarySource === 'string' ? payload.summarySource : undefined
  }
  if (event.type === 'node.skipped') updated.skippedReason = text(payload.reason)
  return { nodes: { ...prev.nodes, [blockId]: updated }, lastSequence: event.sequence }
}

const KINDS: ReadonlySet<string> = new Set<BlockKind>(['input', 'plan', 'build', 'tests', 'review', 'approve', 'human', 'ship'])

export function toViews(nodes: Record<string, RawNode>, blocks: readonly Block[] = []): Record<string, NodeRunView> {
  const out: Record<string, NodeRunView> = {}
  for (const [blockId, n] of Object.entries(nodes)) {
    const kind = blocks.find(b => b.id === blockId)?.kind
    if (kind === undefined || !KINDS.has(kind)) {
      // Without the block's kind there is no honest per-kind sentence, and nothing to attribute a claim to.
      out[blockId] = { blockId, state: n.state, summary: strings.summary.generic[n.state], summaryIsClaim: false, steps: n.steps }
      continue
    }
    const input: SummaryInput = { kind, state: n.state, claim: n.reportedSummary, claimSource: n.claimSource, skippedReason: n.skippedReason }
    out[blockId] = { blockId, state: n.state, summary: summarize(input), summaryIsClaim: claimUsed(input), steps: n.steps }
  }
  return out
}

// The run's own status, folded from run.* events as a state SET: an event names the status the run is now in, so a
// repeat of the same event (run.waiting_approval can be logged twice for one run) leaves it where it was.
export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
const RUN_EVENT_STATUS: Record<string, RunStatus> = {
  'run.created': 'queued',
  'run.started': 'running',
  'run.waiting_approval': 'waiting_approval',
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
}
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['completed', 'failed', 'cancelled'])

export function foldRunStatus(prev: RunStatus | null, type: string): RunStatus | null {
  const next = RUN_EVENT_STATUS[type]
  if (next === undefined) return prev
  if (prev !== null && TERMINAL.has(prev)) return prev // a finished run does not start again
  return next
}

/** The events the bar can show, oldest first. Capped so a long run cannot grow the page without limit. */
export const MAX_LOGGED_EVENTS = 300
export type LogState = { events: Wire[]; runStatus: RunStatus | null }
const emptyLog: LogState = { events: [], runStatus: null }

function foldLog(prev: LogState, event: Wire): LogState {
  if (prev.events.length > 0 && event.sequence <= prev.events[prev.events.length - 1]!.sequence) return prev
  return {
    events: [...prev.events, event].slice(-MAX_LOGGED_EVENTS),
    runStatus: foldRunStatus(prev.runStatus, event.type),
  }
}

// Everything folded from one run's log, stamped with that run's id. State stamped with a different id than the
// run now being watched is treated as empty (see `held`), so a previous run's states can never be drawn on a new run,
// not even for the render before an effect would have cleared them.
type Held = { runId: string | null; stream: StreamState; log: LogState }
const nothingHeld = (runId: string | null): Held => ({ runId, stream: emptyStream, log: emptyLog })

type Action = { type: 'event'; runId: string; event: Wire } | { type: 'reset'; runId: string | null }
function reducer(s: Held, a: Action): Held {
  if (a.type === 'reset') return nothingHeld(a.runId)
  const base = s.runId === a.runId ? s : nothingHeld(a.runId)
  return { runId: a.runId, stream: foldEvent(base.stream, a.event), log: foldLog(base.log, a.event) }
}

export function useRunStream(
  /** Null: there is no run to watch, so nothing connects and nothing is shown. */
  runId: string | null,
  blocks?: readonly Block[],
): { views: Record<string, NodeRunView>; lastSequence: number; connected: boolean; events: readonly Wire[]; runStatus: RunStatus | null } {
  const [state, dispatch] = useReducer(reducer, null, () => nothingHeld(runId))
  const held = state.runId === runId ? state : nothingHeld(runId)
  const { stream, log } = held
  const [connected, setConnected] = useReducer((_: boolean, v: boolean) => v, false)
  const cursor = useRef(0)

  useEffect(() => {
    cursor.current = 0
    dispatch({ type: 'reset', runId })
    if (runId === null) {
      setConnected(false)
      return
    }
    let source: EventSource | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let disposed = false

    const connect = () => {
      const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${cursor.current}`)
      source = es
      es.onopen = () => {
        failures = 0
        setConnected(true)
      }
      es.onmessage = m => {
        let event: Wire
        try {
          event = JSON.parse(m.data as string) as Wire
        } catch {
          return // a frame that is not an event cannot move the cursor
        }
        if (typeof event.sequence !== 'number' || event.sequence <= cursor.current) return
        cursor.current = event.sequence
        dispatch({ type: 'event', runId, event })
      }
      es.onerror = () => {
        es.close() // the browser would retry on its own with no ceiling; the schedule here is the only one
        setConnected(false)
        if (disposed) return
        const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)]!
        failures++
        timer = setTimeout(connect, delay)
      }
    }
    connect()

    return () => {
      disposed = true
      clearTimeout(timer)
      source?.close()
    }
  }, [runId])

  const views = useMemo(() => toViews(stream.nodes, blocks), [stream.nodes, blocks])
  return { views, lastSequence: stream.lastSequence, connected, events: log.events, runStatus: log.runStatus }
}

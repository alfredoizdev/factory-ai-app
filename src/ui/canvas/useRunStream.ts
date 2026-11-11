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

type RawNode = {
  state: NodeState
  steps: string[]
  reportedSummary?: string
  claimSource?: string
  skippedReason?: string
  /** From node.failed: the recorded cause code, the sentence that went with it, and who wrote that sentence. */
  failureCause?: string
  failureMessage?: string
  failureSource?: string
  /** From node.evidence: what the test runner measured. */
  evidence?: NodeRunView['evidence']
  /** From node.reopened: which round this block is on, when it is past the first. */
  round?: number
  /** From node.assessed: the measured risk of the run's change. */
  risk?: NodeRunView['risk']
  /** From node.completed: tokens the provider reported. Undefined: it said nothing; null: it said "unknown". */
  tokens?: number | null
}
export type StreamState = {
  nodes: Record<string, RawNode>
  lastSequence: number
  /** From run.pushed: the approved change was sent to the project's origin, so the Ship stage has really happened. */
  shipped?: { branch: string; pr?: number; merged?: boolean }
}
export const emptyStream: StreamState = { nodes: {}, lastSequence: 0 }

export type Wire = Pick<EventRow, 'sequence' | 'type' | 'payload'>

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

// Pure. Anything it does not recognise only advances the cursor, so an event type added later cannot corrupt a view.
export function foldEvent(prev: StreamState, event: Wire): StreamState {
  if (event.sequence <= prev.lastSequence) return prev // already applied: a replay overlap is not a second step
  const moved: StreamState = { ...prev, lastSequence: event.sequence }

  const payload = (event.payload ?? {}) as Record<string, unknown>
  if (event.type === 'run.pushed') {
    const branch = text(payload.branch)
    return branch === undefined ? moved : { ...moved, shipped: { ...prev.shipped, branch } }
  }
  if (event.type === 'run.pr_opened' && typeof payload.number === 'number') {
    return { ...moved, shipped: { branch: prev.shipped?.branch ?? '', ...prev.shipped, pr: payload.number } }
  }
  if (event.type === 'run.merged') {
    return { ...moved, shipped: { branch: prev.shipped?.branch ?? '', ...prev.shipped, merged: true } }
  }
  const blockId = text(payload.blockId)
  if (blockId === undefined) return moved
  const node = prev.nodes[blockId]

  // node.step carries no state: it only extends the list of a block the log has already given a state.
  // A step for an unseen block would need an invented state, so only the cursor moves.
  if (event.type === 'node.step') {
    const step = text(payload.text)
    if (!node || step === undefined) return moved
    return { ...prev, nodes: { ...prev.nodes, [blockId]: { ...node, steps: [...node.steps, step] } }, lastSequence: event.sequence }
  }

  // node.evidence carries no state either: it attaches what a process measured to a block already seen.
  if (event.type === 'node.evidence') {
    const evidence = evidenceOf(payload)
    if (!node || !evidence) return moved
    return { ...prev, nodes: { ...prev.nodes, [blockId]: { ...node, evidence } }, lastSequence: event.sequence }
  }

  // A person asked for changes: the block starts over for the next round. Nothing from the previous round carries
  // into its view — not its steps, its sentence, its measurement — because none of it describes the work now.
  if (event.type === 'node.reopened') {
    if (!node) return moved
    const round = typeof payload.round === 'number' && payload.round > 1 ? payload.round : undefined
    return { ...prev, nodes: { ...prev.nodes, [blockId]: { state: 'queued', steps: [], round } }, lastSequence: event.sequence }
  }

  if (event.type === 'node.assessed') {
    const level = payload.level === 'low' || payload.level === 'high' ? payload.level : undefined
    const reasons = Array.isArray(payload.reasons) ? payload.reasons.filter((r): r is string => typeof r === 'string') : []
    if (!node || !level) return moved
    return { ...prev, nodes: { ...prev.nodes, [blockId]: { ...node, risk: { level, reasons } } }, lastSequence: event.sequence }
  }

  const state = NODE_EVENT_STATE[event.type]
  if (state === undefined) return moved
  // First sight of a block takes whatever the log says (a run may lack node.queued). After that the state
  // machine decides: an event it forbids, such as a start after a finish, is not applied.
  // (The event is still real, but the view keeps the state the machine allows; the cursor moves so it is not retried.)
  if (node && node.state !== state && !canTransition(node.state, state)) return moved

  const updated: RawNode = { ...node, state, steps: node?.steps ?? [] }
  // A planner's proposal waits for the person with its own words (how many jobs), marked as whose they are.
  if (event.type === 'node.waiting_approval' && typeof payload.summary === 'string') {
    updated.reportedSummary = text(payload.summary)
    updated.claimSource = typeof payload.summarySource === 'string' ? payload.summarySource : undefined
  }
  // Asked again: the old proposal's words go with it.
  if (state === 'queued') updated.reportedSummary = undefined
  if (event.type === 'node.completed') {
    updated.reportedSummary = text(payload.summary)
    // Carry the producer's marker verbatim; summarize/claimUsed decide what it means.
    updated.claimSource = typeof payload.summarySource === 'string' ? payload.summarySource : undefined
    if ('tokens' in payload) updated.tokens = typeof payload.tokens === 'number' ? payload.tokens : null
  }
  if (event.type === 'node.failed') {
    updated.failureCause = text(payload.cause)
    updated.failureMessage = text(payload.message)
    // Same rule as summarySource: carried verbatim, and anything but 'system' is treated as a model's words.
    updated.failureSource = typeof payload.messageSource === 'string' ? payload.messageSource : undefined
  }
  if (event.type === 'node.skipped') updated.skippedReason = text(payload.reason)
  return { ...prev, nodes: { ...prev.nodes, [blockId]: updated }, lastSequence: event.sequence }
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

// Only well-formed numbers pass: a malformed payload yields no evidence rather than evidence with invented parts.
function evidenceOf(payload: Record<string, unknown>): RawNode['evidence'] {
  const duration = count(payload.durationMs)
  if (duration === null) return undefined
  const exitCode = typeof payload.exitCode === 'number' && Number.isInteger(payload.exitCode) ? payload.exitCode : null
  const raw = payload.counts as Record<string, unknown> | null | undefined
  const passed = count(raw?.passed)
  const failed = count(raw?.failed)
  const total = count(raw?.total)
  const counts = passed !== null && failed !== null && total !== null && passed + failed <= total ? { passed, failed, total } : null
  const signal = typeof payload.signal === 'string' ? payload.signal : null
  // Absent (an older event) and null (could not check) both mean unknown; only a real list counts as checked.
  const files = Array.isArray(payload.changedTestFiles) ? payload.changedTestFiles.filter((f): f is string => typeof f === 'string') : null
  const filesCount = files === null ? null : Math.max(count(payload.changedTestFilesCount) ?? 0, files.length)
  return { counts, exitCode, signal, durationMs: duration, changedTestFiles: files, changedTestFilesCount: filesCount }
}

const KINDS: ReadonlySet<string> = new Set<BlockKind>(['input', 'plan', 'build', 'tests', 'review', 'approve', 'human', 'ship'])

// Evidence and usage travel to the card as they were recorded; usage cost is never reported for a real builder.
function facts(n: RawNode): Pick<NodeRunView, 'evidence' | 'usage' | 'risk' | 'round'> {
  return {
    ...(n.round ? { round: n.round } : {}),
    ...(n.evidence ? { evidence: n.evidence } : {}),
    ...(n.risk ? { risk: n.risk } : {}),
    ...(n.tokens !== undefined ? { usage: { tokens: n.tokens, costCents: null } } : {}),
  }
}

// A stage the real agent does not have yet is skipped with one of these sentences: that is about the product, not the run.
const NOT_BUILT: ReadonlySet<string> = new Set([strings.run.notYet.plan, strings.run.notYet.review])
const notBuilt = (n: RawNode) => n.state === 'skipped' && n.skippedReason !== undefined && NOT_BUILT.has(n.skippedReason)

export function toViews(
  nodes: Record<string, RawNode>,
  blocks: readonly Block[] = [],
  shipped?: StreamState['shipped'],
): Record<string, NodeRunView> {
  const out: Record<string, NodeRunView> = {}
  for (const [blockId, n] of Object.entries(nodes)) {
    const kind = blocks.find(b => b.id === blockId)?.kind
    if (kind === undefined || !KINDS.has(kind)) {
      // Without the block's kind there is no honest per-kind sentence, and nothing to attribute a claim to.
      out[blockId] = { blockId, state: n.state, summary: strings.summary.generic[n.state], summaryIsClaim: false, steps: n.steps, ...facts(n) }
      continue
    }
    const failed = n.state === 'failed'
    const input: SummaryInput = {
      kind,
      state: n.state,
      claim: failed ? n.failureMessage : n.reportedSummary,
      claimSource: failed ? n.failureSource : n.claimSource,
      cause: failed ? n.failureCause : undefined,
      skippedReason: n.skippedReason,
      // Measured counts outrank any sentence: summarize builds its line from them first.
      counts: n.evidence?.counts ?? undefined,
    }
    out[blockId] = { blockId, state: n.state, summary: summarize(input), summaryIsClaim: claimUsed(input), steps: n.steps, ...facts(n), ...(notBuilt(n) ? { notBuilt: true } : {}) }
  }
  // Shipping is pushing the approved branch. Once the record says it happened, the Ship stage shows it, measured
  // (it is the app's own record of a push git accepted), never a claim.
  if (shipped) {
    for (const b of blocks.filter(b => b.kind === 'ship')) {
      // Merged: shipped. A pull request still open waits on the person's merge. Only pushed: it went to origin.
      out[b.id] = shipped.merged
        ? { blockId: b.id, state: 'passed', summary: strings.summary.mergedVia(shipped.pr ?? null), summaryIsClaim: false, steps: [] }
        : shipped.pr !== undefined
          ? { blockId: b.id, state: 'waiting_approval', summary: strings.summary.prOpen(shipped.pr), summaryIsClaim: false, steps: [] }
          : { blockId: b.id, state: 'passed', summary: strings.summary.shippedTo(shipped.branch), summaryIsClaim: false, steps: [] }
    }
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
): { views: Record<string, NodeRunView>; lastSequence: number; connected: boolean; events: readonly Wire[]; runStatus: RunStatus | null; loaded: boolean } {
  const [state, dispatch] = useReducer(reducer, null, () => nothingHeld(runId))
  const held = state.runId === runId ? state : nothingHeld(runId)
  const { stream, log } = held
  const [connected, setConnected] = useReducer((_: boolean, v: boolean) => v, false)
  const cursor = useRef(0)
  // The run whose recorded events have all arrived: until then the page shows placeholders, not a run assembling itself.
  const [loadedFor, setLoadedFor] = useReducer((_: string | null, v: string | null) => v, null)

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
      if (typeof es.addEventListener === 'function') es.addEventListener('caughtup', () => setLoadedFor(runId))
      else setLoadedFor(runId)
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
    // Never stuck on placeholders: if the end of the replay is not heard of, the run is shown anyway.
    const fallback = setTimeout(() => setLoadedFor(runId), 2500)

    return () => {
      disposed = true
      clearTimeout(fallback)
      clearTimeout(timer)
      source?.close()
    }
  }, [runId])

  const views = useMemo(() => toViews(stream.nodes, blocks, stream.shipped), [stream.nodes, blocks, stream.shipped])
  return { views, lastSequence: stream.lastSequence, connected, events: log.events, runStatus: log.runStatus, loaded: runId !== null && loadedFor === runId }
}

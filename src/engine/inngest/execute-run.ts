import { eq } from 'drizzle-orm'
import { NonRetriableError } from 'inngest'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { nodeRuns, runs, workflowVersions } from '@/db/schema'
import { STAGE_ORDER, type BlockKind, type Graph } from '@/domain/graph'
import { canTransition, rollUpRunStatus, type NodeState, type RunStatus } from '@/domain/states'
import { appendEventSync, type DbHandle, type EventType } from '@/engine/events'
import { APPROVAL_DECIDED, inngest, RUN_REQUESTED } from '@/engine/inngest/client'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { demoProvider } from '@/providers/demo'
import type { AgentProvider } from '@/providers/types'
import { strings } from '@/ui/strings'

// The durable run. Every state change is written as an event in the same transaction as the row it changes;
// nothing here keeps state the canvas could see that the event log does not hold. Each node is one step, so
// Inngest memoises finished nodes and a restart resumes at the first unfinished one. Cancellation is cooperative.

export const MAX_ATTEMPTS = 2
export const DEFAULT_TIMEOUT_MS = 600_000
// Longest wait Inngest offers: a person may take days, and nothing may time the run into a verdict for them.
const APPROVAL_WAIT = '365d'
const CANCEL_POLL_MS = 100

// The part of Inngest's step tools this file uses, so the orchestration can be driven without a dev server.
export type StepApi = {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>
  waitForEvent(
    id: string,
    opts: { event: string; timeout: string; match: string },
  ): Promise<{ data: { decision?: unknown } } | null>
}

export type ExecutorDeps = { resolveProvider: (providerId: string) => AgentProvider }

const defaultDeps: ExecutorDeps = {
  resolveProvider: id => {
    if (id === DEMO_PROVIDER_ID) return demoProvider
    throw new NonRetriableError(`Unknown provider ${id}`)
  },
}

type PlannedBlock = { id: string; kind: BlockKind; enabled: boolean; timeoutMs: number }
type Plan = { providerId: string; request: string; blocks: PlannedBlock[] }
type Outcome = { outcome: 'passed' | 'failed' | 'cancelled' | 'skipped' | 'parked' }

const now = () => new Date().toISOString()

// ---- atomic state writes: the row change and its event commit together or not at all --------------------------

function withTx<T>(fn: (tx: DbHandle) => T): T {
  return db.transaction(tx => fn(tx), { behavior: 'immediate' })
}

function runStatusOf(h: DbHandle, runId: string): string | undefined {
  return h.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)).get()?.s
}

function isCancelled(runId: string): boolean {
  return runStatusOf(db, runId) === 'cancelled'
}

// queued -> running. Returns false when the run was cancelled (or already finished) before it began.
function startRun(runId: string): boolean {
  return withTx(tx => {
    const status = runStatusOf(tx, runId)
    if (status === 'running') return true // replay after a crash: already started
    if (status !== 'queued') return false
    tx.update(runs).set({ status: 'running', startedAt: now() }).where(eq(runs.id, runId)).run()
    appendEventSync({ runId, type: 'run.started' }, tx)
    return true
  })
}

// Moves the run to a status that is not terminal (running / waiting_approval) and appends the event for it.
function setRunStatus(runId: string, status: RunStatus, event: { type: EventType; payload?: unknown }): void {
  withTx(tx => {
    const current = runStatusOf(tx, runId)
    if (current === 'cancelled' || current === 'failed' || current === 'completed') return
    if (current !== status) tx.update(runs).set({ status }).where(eq(runs.id, runId)).run()
    appendEventSync({ runId, type: event.type, payload: event.payload } as Parameters<typeof appendEventSync>[0], tx)
  })
}

function finishRun(runId: string, status: 'completed' | 'failed', payload?: unknown): void {
  withTx(tx => {
    const current = runStatusOf(tx, runId)
    if (current === 'cancelled' || current === 'failed' || current === 'completed') return
    tx.update(runs).set({ status, finishedAt: now() }).where(eq(runs.id, runId)).run()
    // A failed run will never start the blocks it did not reach, so they end as cancelled rather than read queued.
    if (status === 'failed') cancelUnreachedNodes(tx, runId)
    appendEventSync({ runId, type: status === 'completed' ? 'run.completed' : 'run.failed', payload }, tx)
  })
}

type NodeRow = typeof nodeRuns.$inferSelect

// Writes a node state change plus its event. A change the state machine forbids (for example resurrecting a node
// that cancelRun already cancelled) is refused and nothing is written.
function transitionNode(
  tx: DbHandle,
  node: NodeRow,
  to: NodeState,
  event: { type: EventType; payload?: Record<string, unknown> },
  fields: Partial<Pick<NodeRow, 'summary' | 'failureCause'>> = {},
): boolean {
  if (!canTransition(node.state as NodeState, to)) return false
  const terminal = to === 'passed' || to === 'failed' || to === 'skipped' || to === 'cancelled'
  tx.update(nodeRuns)
    .set({ state: to, ...fields, ...(terminal ? { finishedAt: now() } : {}) })
    .where(eq(nodeRuns.id, node.id))
    .run()
  appendEventSync(
    { runId: node.runId, nodeRunId: node.id, type: event.type, payload: { blockId: node.blockId, ...event.payload } } as Parameters<typeof appendEventSync>[0],
    tx,
  )
  node.state = to
  return true
}

// Every block still queued when its run has failed was never reached and never will be.
function cancelUnreachedNodes(tx: DbHandle, runId: string): void {
  for (const node of tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all()) {
    if (node.state === 'queued') transitionNode(tx, node, 'cancelled', { type: 'node.cancelled', payload: { reason: strings.run.notReached } })
  }
}

// Finds this block's node run or creates it. Refuses (null) once the run is cancelled, inside the same transaction,
// so a node cannot slip in after cancelRun swept the existing ones.
function openNodeIn(tx: DbHandle, runId: string, blockId: string): NodeRow | null {
  if (runStatusOf(tx, runId) === 'cancelled') return null
  const existing = tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === blockId)
  if (existing) return existing
  const run = tx.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId)).get()
  if (!run) return null
  const row = tx
    .insert(nodeRuns)
    .values({ id: ulid(), projectId: run.projectId, runId, blockId, state: 'queued', attempt: 1 })
    .returning()
    .get()
  // A row the canvas can see has an event: node.queued commits in the same transaction as the insert.
  appendEventSync({ runId, nodeRunId: row.id, type: 'node.queued', payload: { blockId } }, tx)
  return row
}

function freshNode(id: string): NodeRow {
  const row = db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).get()
  if (!row) throw new Error(`node run ${id} vanished`)
  return row
}

function outcomeOf(state: string): Outcome['outcome'] | null {
  if (state === 'passed' || state === 'failed' || state === 'cancelled' || state === 'skipped') return state
  return null
}

// ---- one provider attempt, raced against the timeout and against cancellation ----------------------------------

type AttemptResult =
  | { kind: 'done'; summary: string }
  | { kind: 'error'; message: string }
  | { kind: 'ended' }
  | { kind: 'crashed'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

async function runAttempt(
  provider: AgentProvider,
  block: PlannedBlock,
  request: string,
  runId: string,
  onStep: (text: string) => void,
): Promise<AttemptResult> {
  const controller = new AbortController()
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  // These two settle on their own clocks, so a provider that yields nothing cannot hold the node forever.
  const guard = new Promise<AttemptResult>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), block.timeoutMs)
    poll = setInterval(() => {
      if (isCancelled(runId)) resolve({ kind: 'cancelled' })
    }, CANCEL_POLL_MS)
  })

  const consume = (async (): Promise<AttemptResult> => {
    try {
      for await (const ev of provider.execute({ blockKind: block.kind, request }, { signal: controller.signal })) {
        if (closed) return { kind: 'ended' } // the node already ended; a late step must not be recorded
        if (ev.type === 'step') onStep(ev.text)
        else if (ev.type === 'done') return { kind: 'done', summary: ev.summary }
        else if (ev.type === 'error') return { kind: 'error', message: ev.message }
        // evidence is recorded from Task 5 of the M3a plan onwards
      }
      return { kind: 'ended' }
    } catch (e) {
      return { kind: 'crashed', detail: e instanceof Error ? e.message : String(e) }
    }
  })()

  try {
    return await Promise.race([consume, guard])
  } finally {
    closed = true
    clearTimeout(timer)
    clearInterval(poll)
    controller.abort() // stop a provider still working after a timeout or cancel; harmless after it finished
  }
}

// ---- nodes -------------------------------------------------------------------------------------------------------

function skipNode(runId: string, block: PlannedBlock): Outcome {
  return withTx(tx => {
    const node = openNodeIn(tx, runId, block.id)
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    transitionNode(tx, node, 'skipped', { type: 'node.skipped', payload: { reason: strings.run.skippedDisabled } })
    return { outcome: 'skipped' }
  })
}

async function runProviderNode(runId: string, plan: Plan, block: PlannedBlock, deps: ExecutorDeps): Promise<Outcome> {
  // Resolved before any row exists, so an unknown provider cannot strand a node.
  const provider = deps.resolveProvider(plan.providerId)

  // Row, node.queued and node.started commit together: a node is never left queued.
  const opened = withTx((tx): NodeRow | Outcome => {
    const node = openNodeIn(tx, runId, block.id)
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled } // replay of a step that already finished
    if (node.state === 'queued') {
      if (!transitionNode(tx, node, 'running', { type: 'node.started', payload: { attempt: node.attempt } })) {
        return { outcome: 'cancelled' }
      }
      tx.update(nodeRuns).set({ startedAt: now() }).where(eq(nodeRuns.id, node.id)).run()
    }
    return node
  })
  if ('outcome' in opened) return opened

  for (let attempt = freshNode(opened.id).attempt; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await runAttempt(provider, block, plan.request, runId, text => {
      withTx(tx => {
        const node = freshNode(opened.id)
        if (node.state === 'running') {
          appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt, text } }, tx)
        }
      })
    })

    if (result.kind === 'cancelled') return { outcome: 'cancelled' }

    if (result.kind === 'done') {
      const done = withTx(tx =>
        transitionNode(tx, freshNode(opened.id), 'passed', {
          type: 'node.completed',
          payload: { summary: result.summary, summarySource: 'provider', attempt },
        }, { summary: result.summary }),
      )
      return { outcome: done ? 'passed' : 'cancelled' }
    }

    const cause =
      result.kind === 'timeout'
        ? 'timeout'
        : result.kind === 'error'
          ? 'provider_error'
          : result.kind === 'crashed'
            ? 'provider_crashed'
            : 'no_result'
    const message =
      result.kind === 'timeout'
        ? strings.run.timedOut(Math.round(block.timeoutMs / 1000))
        : result.kind === 'error'
          ? result.message
          : result.kind === 'crashed'
            ? strings.run.providerCrashed
            : strings.run.noResult
    // The exception's own text is kept: a failure whose cause is lost cannot be explained to the person reading it.
    const detail = result.kind === 'crashed' ? result.detail : undefined

    // maxAttempts is 2 per node, with one deliberate exception: a timeout is never retried. A hang that already
    // used the whole timeout would double the wait before a person sees anything, and the cause is recorded
    // ('timeout') so they can retry on purpose.
    const canRetry = attempt < MAX_ATTEMPTS && result.kind !== 'timeout'
    if (canRetry) {
      // The node stays running: failed is terminal in the state machine, so only the final failure is recorded as one.
      withTx(tx => {
        const node = freshNode(opened.id)
        if (node.state !== 'running') return
        tx.update(nodeRuns).set({ attempt: attempt + 1 }).where(eq(nodeRuns.id, node.id)).run()
        appendEventSync(
          {
            runId,
            nodeRunId: node.id,
            type: 'node.step',
            payload: {
              blockId: block.id,
              attempt: attempt + 1,
              text: strings.run.retrying,
              retry: true,
              previousCause: cause,
              previousMessage: message,
              ...(detail ? { previousDetail: detail } : {}),
            },
          },
          tx,
        )
      })
      continue
    }

    const failed = withTx(tx =>
      transitionNode(tx, freshNode(opened.id), 'failed', {
        type: 'node.failed',
        // messageSource says who wrote `message`: only a provider_error carries the provider's own words. The
        // column holds the cause code alone; the message lives in this event, the one place the canvas reads it.
        payload: { cause, message, messageSource: cause === 'provider_error' ? 'provider' : 'system', attempt, ...(detail ? { detail } : {}) },
      }, { failureCause: cause }),
    )
    return { outcome: failed ? 'failed' : 'cancelled' }
  }
  return { outcome: 'failed' } // unreachable: the loop always returns
}

// A human block never calls a provider: it records that it is waiting and the function parks.
function parkHumanNode(runId: string, block: PlannedBlock): Outcome {
  const result = withTx((tx): Outcome => {
    const node = openNodeIn(tx, runId, block.id)
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    if (node.state === 'queued') {
      if (!transitionNode(tx, node, 'running', { type: 'node.started', payload: { attempt: node.attempt } })) return { outcome: 'cancelled' }
      tx.update(nodeRuns).set({ startedAt: now() }).where(eq(nodeRuns.id, node.id)).run()
    }
    // The run's own state change is an event too, appended where the status changes. It precedes the node event so
    // the log ends on node.waiting_approval, the block the person has to act on.
    if (runStatusOf(tx, runId) === 'running') {
      tx.update(runs).set({ status: 'waiting_approval' }).where(eq(runs.id, runId)).run()
      appendEventSync({ runId, type: 'run.waiting_approval', payload: { blockId: block.id } }, tx)
    }
    if (node.state === 'running' && !transitionNode(tx, node, 'waiting_approval', { type: 'node.waiting_approval' })) return { outcome: 'cancelled' }
    return { outcome: 'parked' }
  })
  return result
}

function decideHumanNode(runId: string, block: PlannedBlock, approved: boolean): Outcome {
  const node = db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === block.id)
  if (!node) return { outcome: 'cancelled' }
  const ok = withTx(tx => {
    const fresh = freshNode(node.id)
    const moved = approved
      ? transitionNode(tx, fresh, 'passed', { type: 'node.completed', payload: { summary: strings.run.resumed, summarySource: 'system' } }, { summary: strings.run.resumed })
      : transitionNode(tx, fresh, 'failed', { type: 'node.failed', payload: { cause: 'rejected', message: strings.run.rejected, messageSource: 'system' } }, { failureCause: 'rejected' })
    if (moved && runStatusOf(tx, runId) === 'waiting_approval') {
      tx.update(runs).set({ status: 'running' }).where(eq(runs.id, runId)).run()
      appendEventSync({ runId, type: 'run.started', payload: { resumed: true } }, tx)
    }
    return moved
  })
  return { outcome: ok ? (approved ? 'passed' : 'failed') : 'cancelled' }
}

// ---- the orchestration ---------------------------------------------------------------------------------------------

function loadPlan(runId: string): Plan {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run) throw new NonRetriableError(`${strings.errors.runNotFound} (${runId})`)
  const version = db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)).get()
  if (!version) throw new NonRetriableError(`${strings.errors.runNotFound} (${runId})`)
  const graph = JSON.parse(version.graphJson) as Graph
  // Stage order, then the order blocks were added within a stage. Disabled blocks stay in the plan so they are reported.
  const ordered = STAGE_ORDER.flatMap(kind => graph.blocks.filter(b => b.kind === kind))
  const blocks = ordered.map(b => {
    const t = (b.config as { timeoutMs?: unknown }).timeoutMs
    return { id: b.id, kind: b.kind, enabled: b.enabled, timeoutMs: typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_MS }
  })
  return { providerId: run.providerId, request: run.request, blocks }
}

// Deliberately tolerant: it never reads run.created, so a run missing that event still executes.
export async function orchestrateRun(runId: string, step: StepApi, deps: ExecutorDeps = defaultDeps): Promise<void> {
  const plan = await step.run('plan', () => loadPlan(runId))
  const started = await step.run('start', () => startRun(runId))
  if (!started) return // cancelled (or already finished) before it began

  for (const block of plan.blocks) {
    let result: Outcome
    if (!block.enabled) {
      result = await step.run(`node-${block.id}`, () => skipNode(runId, block))
    } else if (block.kind === 'human') {
      result = await step.run(`node-${block.id}`, () => parkHumanNode(runId, block))
      if (result.outcome === 'parked') {
        const decision = await step.waitForEvent(`approval-${block.id}`, {
          event: APPROVAL_DECIDED,
          timeout: APPROVAL_WAIT,
          match: 'data.runId',
        })
        // No decision (the wait expired) leaves the run waiting on the person; it is never a verdict.
        if (!decision) return
        const approved = decision.data.decision === 'approved'
        result = await step.run(`decide-${block.id}`, () => decideHumanNode(runId, block, approved))
      }
    } else {
      result = await step.run(`node-${block.id}`, () => runProviderNode(runId, plan, block, deps))
    }
    if (result.outcome === 'cancelled') return // run.cancelled and node.cancelled were written by cancelRun
    if (result.outcome === 'failed') {
      await step.run('fail', () => finishRun(runId, 'failed', { blockId: block.id }))
      return
    }
  }

  // Everything finished: let the roll-up, not an assumption, decide whether that is success.
  await step.run('finish', () => {
    const states = db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().map(n => n.state as NodeState)
    const status = rollUpRunStatus(states)
    if (status === 'completed') finishRun(runId, 'completed')
    else if (status === 'failed') finishRun(runId, 'failed')
    else if (status === 'waiting_approval') setRunStatus(runId, 'waiting_approval', { type: 'run.waiting_approval' })
    return status
  })
}

// Last resort when a step throws for good (missing run, exhausted retries): nothing may be left running with no
// recorded cause. Unfinished nodes fail, then the run fails, each through the guarded transitions.
export function failRunAfterError(runId: string): void {
  withTx(tx => {
    const status = runStatusOf(tx, runId)
    if (status === undefined || status === 'cancelled' || status === 'failed' || status === 'completed') return
    for (const node of tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all()) {
      if (node.state === 'queued') {
        // queued -> failed is not a legal transition; a node that never started is cancelled, and the run carries the failure.
        transitionNode(tx, node, 'cancelled', { type: 'node.cancelled', payload: { reason: strings.run.internalFailure } })
        continue
      }
      transitionNode(tx, node, 'failed', {
        type: 'node.failed',
        payload: { cause: 'internal_error', message: strings.run.internalFailure, messageSource: 'system' },
      }, { failureCause: 'internal_error' })
    }
    tx.update(runs).set({ status: 'failed', finishedAt: now() }).where(eq(runs.id, runId)).run()
    appendEventSync({ runId, type: 'run.failed', payload: { cause: 'internal_error', message: strings.run.internalFailure } }, tx)
  })
}

export const executeRun = inngest.createFunction(
  {
    id: 'execute-run',
    triggers: [{ event: RUN_REQUESTED }],
    onFailure: async ({ event }) => {
      const runId = (event.data.event.data as { runId?: unknown }).runId
      if (typeof runId === 'string') failRunAfterError(runId)
    },
  },
  async ({ event, step }) => {
    const { runId } = event.data as { runId: string }
    await orchestrateRun(runId, step as unknown as StepApi)
  },
)

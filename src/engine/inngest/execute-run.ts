import { eq } from 'drizzle-orm'
import { NonRetriableError } from 'inngest'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { claims, evidence, nodeRuns, projects, runs, usageRecords, workflowVersions } from '@/db/schema'
import { STAGE_ORDER, type BlockKind, type Graph } from '@/domain/graph'
import { canReopen, canTransition, rollUpRunStatus, type NodeState, type RunStatus } from '@/domain/states'
import { appendEventSync, type DbHandle, type EventType } from '@/engine/events'
import { APPROVAL_DECIDED, inngest, RUN_REQUESTED } from '@/engine/inngest/client'
import { clip, redact } from '@/engine/redact'
import { MAX_REVISIONS, takeRecordedDecision, type Decision } from '@/engine/approvals'
import { imagePathsFor } from '@/engine/attachments'
import { assessRisk, type RiskAssessment, type TestFacts } from '@/engine/risk'
import type { TestRun } from '@/engine/test-runner'
import { createRunWorktree, type RunWorkspace } from '@/engine/worktree'
import { claudeProvider } from '@/providers/claude'
import { CLAUDE_PROVIDER_ID, DEMO_PROVIDER_ID } from '@/providers/ids'
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

export type ExecutorDeps = {
  resolveProvider: (providerId: string) => AgentProvider
  /** Makes the run's working copy. Only called for a provider that works on files. `startPoint`: a follow-up's parent commit. */
  createWorktree?: (repoPath: string, runId: string, startPoint?: string) => RunWorkspace
}

const defaultDeps: ExecutorDeps = {
  resolveProvider: id => {
    if (id === DEMO_PROVIDER_ID) return demoProvider
    if (id === CLAUDE_PROVIDER_ID) return claudeProvider
    throw new NonRetriableError(`Unknown provider ${id}`)
  },
  createWorktree: (repo, runId, startPoint) => createRunWorktree(repo, runId, undefined, startPoint),
}

const MAX_LISTED_FILES = 20
/** A step line is short: it says what the agent is doing, it is not a log. */
const STEP_MAX = 240

type PlannedBlock = { id: string; kind: BlockKind; enabled: boolean; timeoutMs: number }
type Plan = {
  providerId: string
  request: string
  blocks: PlannedBlock[]
  repoPath: string | null
  testCommand: string | null
  /** Read once when the run starts: changing the switch mid-run does not change this run. */
  autoApproveLowRisk: boolean
  /** A follow-up's parent request: what is already done in the folder it starts from. */
  previousRequest: string | null
}
/** What a block's execution may touch: the run's worktree (null for the demo) and the project's test command. */
type Workspace = { workdir: string | null; testCommand: string | null; baseCommit: string | null; previousRequest?: string | null }
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

type Done = { summary: string; source: 'provider' | 'system'; tokens: number | null | undefined }
type AttemptResult =
  | ({ kind: 'done' } & Done)
  | { kind: 'error'; message: string; source: 'provider' | 'system'; noRetry: boolean }
  | { kind: 'ended' }
  | { kind: 'crashed'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

async function runAttempt(
  provider: AgentProvider,
  block: PlannedBlock,
  request: string,
  runId: string,
  workspace: Workspace,
  revisionNote: string | null,
  images: readonly string[],
  onStep: (text: string) => void,
  onEvidence: (data: TestRun) => void,
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
      const input = {
        blockKind: block.kind,
        request,
        workdir: workspace.workdir ?? undefined,
        testCommand: workspace.testCommand,
        baseCommit: workspace.baseCommit ?? undefined,
        revisionNote: revisionNote ?? undefined,
        previousRequest: workspace.previousRequest ?? undefined,
        images: images.length > 0 ? [...images] : undefined,
      }
      for await (const ev of provider.execute(input, { signal: controller.signal })) {
        if (closed) return { kind: 'ended' } // the node already ended; a late step must not be recorded
        if (ev.type === 'step') onStep(ev.text)
        else if (ev.type === 'evidence') onEvidence(ev.data)
        else if (ev.type === 'done') return { kind: 'done', summary: ev.summary, source: ev.source ?? 'provider', tokens: ev.usage?.tokens }
        else return { kind: 'error', message: ev.message, source: ev.source ?? 'provider', noRetry: ev.cause === 'tests_failed' }
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

function skipNode(runId: string, block: PlannedBlock, reason: string = strings.run.skippedDisabled): Outcome {
  return withTx(tx => {
    const node = openNodeIn(tx, runId, block.id)
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    transitionNode(tx, node, 'skipped', { type: 'node.skipped', payload: { reason } })
    return { outcome: 'skipped' }
  })
}

// Evidence: the full record (with the redacted output tail) goes to its own table; the event carries numbers only, so
// the browser never receives command output. Written inside the transaction that ends the attempt, so a measurement
// and the block's result are stored together or not at all: a crash in between cannot leave a measurement whose
// block then re-runs and measures again.
function writeEvidence(tx: DbHandle, node: NodeRow, blockId: string, measured: readonly TestRun[]): void {
  if (node.state !== 'running') return
  const { runId, id: nodeRunId } = node
  for (const data of measured) {
    tx.insert(evidence)
      .values({ id: ulid(), projectId: node.projectId, runId, nodeRunId, kind: 'test_run', source: 'test-runner', dataJson: JSON.stringify(data), createdAt: now() })
      .run()
    appendEventSync(
      {
        runId,
        nodeRunId,
        type: 'node.evidence',
        payload: {
          blockId,
          kind: 'test_run',
          exitCode: data.exitCode,
          signal: data.signal,
          durationMs: data.durationMs,
          counts: data.counts,
          // Paths only, at most a screenful: enough to show that the tests were touched, and which.
          changedTestFiles: data.changedTestFiles?.slice(0, MAX_LISTED_FILES).map(f => clip(f, 160)) ?? null,
          changedTestFilesCount: data.changedTestFiles?.length ?? null,
        },
      },
      tx,
    )
  }
}

// What a finished block leaves behind besides its state: the usage the provider reported (cost is never stored for
// the subscription builder — not reported, never 0), and its sentence as a claim when a model wrote it.
function recordDoneFacts(tx: DbHandle, node: NodeRow, done: Done): void {
  if (done.tokens !== undefined) {
    tx.insert(usageRecords).values({ id: ulid(), projectId: node.projectId, nodeRunId: node.id, tokens: done.tokens, costCents: null, createdAt: now() }).run()
  }
  if (done.source !== 'system' && done.summary.trim() !== '') {
    tx.insert(claims).values({ id: ulid(), projectId: node.projectId, runId: node.runId, nodeRunId: node.id, text: done.summary, createdAt: now() }).run()
  }
}

async function runProviderNode(
  runId: string,
  plan: Plan,
  block: PlannedBlock,
  deps: ExecutorDeps,
  workspace: Workspace,
  revisionNote: string | null = null,
  images: readonly string[] = [],
): Promise<Outcome> {
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
    // Held until the attempt ends, then written in the same transaction as its outcome.
    const measured: TestRun[] = []
    const result = await runAttempt(
      provider,
      block,
      plan.request,
      runId,
      workspace,
      revisionNote,
      images,
      text => {
        withTx(tx => {
          const node = freshNode(opened.id)
          // Everything a real agent prints is cleaned here, before it can reach the log or the browser.
          const clean = clip(redact(text), STEP_MAX)
          if (node.state === 'running') {
            appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt, text: clean } }, tx)
          }
        })
      },
      data => measured.push(data),
    )

    if (result.kind === 'cancelled') return { outcome: 'cancelled' }

    if (result.kind === 'done') {
      const done = withTx(tx => {
        const node = freshNode(opened.id)
        if (!canTransition(node.state as NodeState, 'passed')) return false
        writeEvidence(tx, node, block.id, measured)
        const moved = transitionNode(tx, node, 'passed', {
          type: 'node.completed',
          payload: {
            summary: result.summary,
            summarySource: result.source,
            attempt,
            // Present only when the provider said something about usage; null inside means "not reported".
            ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
          },
        }, { summary: result.summary })
        if (!moved) return false
        recordDoneFacts(tx, node, result)
        return true
      })
      return { outcome: done ? 'passed' : 'cancelled' }
    }

    const cause =
      result.kind === 'timeout'
        ? 'timeout'
        : result.kind === 'error'
          ? result.noRetry
            ? 'tests_failed'
            : 'provider_error'
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
    // Redacted like every other text from a provider: an exception message can carry a token or a path with one.
    const detail = result.kind === 'crashed' ? clip(redact(result.detail), 300) : undefined

    // maxAttempts is 2 per node, with one deliberate exception: a timeout is never retried. A hang that already
    // used the whole timeout would double the wait before a person sees anything, and the cause is recorded
    // ('timeout') so they can retry on purpose.
    // Failing tests are not retried either: running the same suite again on the same code proves nothing new.
    const canRetry = attempt < MAX_ATTEMPTS && result.kind !== 'timeout' && !(result.kind === 'error' && result.noRetry)
    if (canRetry) {
      // The node stays running: failed is terminal in the state machine, so only the final failure is recorded as one.
      withTx(tx => {
        const node = freshNode(opened.id)
        if (node.state !== 'running') return
        writeEvidence(tx, node, block.id, measured)
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

    const failed = withTx(tx => {
      const node = freshNode(opened.id)
      if (!canTransition(node.state as NodeState, 'failed')) return false
      writeEvidence(tx, node, block.id, measured)
      return transitionNode(tx, node, 'failed', {
        type: 'node.failed',
        // messageSource says who wrote `message`: only a provider_error carries the provider's own words. The
        // column holds the cause code alone; the message lives in this event, the one place the canvas reads it.
        payload: {
          cause,
          message,
          messageSource: result.kind === 'error' ? result.source : 'system',
          attempt,
          ...(detail ? { detail } : {}),
        },
      }, { failureCause: cause })
    })
    return { outcome: failed ? 'failed' : 'cancelled' }
  }
  return { outcome: 'failed' } // unreachable: the loop always returns
}

// What the tests of this run measured, read back from its evidence: the gate is judged on records, not on a summary.
function testFactsOf(runId: string): TestFacts {
  // The latest test run of each block: an earlier round's result says nothing about the change as it is now.
  const latest = new Map<string, { createdAt: string; id: string; data: TestRun }>()
  for (const e of db.select().from(evidence).where(eq(evidence.runId, runId)).all()) {
    if (e.kind !== 'test_run') continue
    const seen = latest.get(e.nodeRunId)
    if (!seen || e.createdAt > seen.createdAt || (e.createdAt === seen.createdAt && e.id > seen.id)) {
      latest.set(e.nodeRunId, { createdAt: e.createdAt, id: e.id, data: JSON.parse(e.dataJson) as TestRun })
    }
  }
  const runsOfTests = [...latest.values()].map(v => v.data)
  return {
    testsRan: runsOfTests.length > 0,
    testsPassed: runsOfTests.length > 0 && runsOfTests.every(t => t.exitCode === 0 && !t.signal),
    // Unknown (null) counts as changed: what could not be checked is not assumed untouched.
    testsChanged: runsOfTests.some(t => t.changedTestFiles === null || (t.changedTestFiles?.length ?? 0) > 0),
  }
}

function assessGate(runId: string, block: PlannedBlock, workspace: Workspace): RiskAssessment | null {
  if (!workspace.workdir || !workspace.baseCommit) return null
  const assessment = assessRisk(workspace.workdir, workspace.baseCommit, testFactsOf(runId))
  withTx(tx => {
    const node = openNodeIn(tx, runId, block.id)
    if (!node || outcomeOf(node.state)) return
    appendEventSync(
      {
        runId,
        nodeRunId: node.id,
        type: 'node.assessed',
        payload: {
          blockId: block.id,
          level: assessment.level,
          reasons: assessment.reasons.map(r => clip(r, 200)),
          filesCount: assessment.files.length,
          linesChanged: assessment.linesChanged,
        },
      },
      tx,
    )
  })
  return assessment
}

// The person chose not to be asked about low-risk changes, and this one measured low: the gate opens on its own,
// saying so in the app's own words. The assessment that justified it is already on the record (node.assessed).
function passLowRiskGate(runId: string, block: PlannedBlock): Outcome {
  return withTx((tx): Outcome => {
    const node = openNodeIn(tx, runId, block.id)
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    if (node.state === 'queued') {
      if (!transitionNode(tx, node, 'running', { type: 'node.started', payload: { attempt: node.attempt } })) return { outcome: 'cancelled' }
      tx.update(nodeRuns).set({ startedAt: now() }).where(eq(nodeRuns.id, node.id)).run()
    }
    const passed = transitionNode(
      tx,
      node,
      'passed',
      { type: 'node.completed', payload: { summary: strings.risk.passedLow, summarySource: 'system', autoApproved: true } },
      { summary: strings.risk.passedLow },
    )
    return { outcome: passed ? 'passed' : 'cancelled' }
  })
}

// The person asked for changes: every block from the builder to the human check goes back to queued for the next
// round, in one transaction, each with a node.reopened event carrying the round and the person's note. Blocks that
// were skipped stay skipped. The run is running again. Nothing in the worktree is touched: the next round builds on it.
function reopenForRevision(runId: string, blocks: readonly PlannedBlock[], round: number, note: string | null): boolean {
  return withTx(tx => {
    if (runStatusOf(tx, runId) !== 'waiting_approval') return false
    const clean = note ? clip(redact(note), 500) : null
    for (const block of blocks) {
      const node = tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === block.id)
      if (!node || !canReopen(node.state as NodeState)) continue
      tx.update(nodeRuns)
        .set({ state: 'queued', attempt: 1, summary: null, failureCause: null, startedAt: null, finishedAt: null })
        .where(eq(nodeRuns.id, node.id))
        .run()
      appendEventSync({ runId, nodeRunId: node.id, type: 'node.reopened', payload: { blockId: block.id, round, note: clean } }, tx)
    }
    tx.update(runs).set({ status: 'running' }).where(eq(runs.id, runId)).run()
    appendEventSync({ runId, type: 'run.started', payload: { resumed: true, round } }, tx)
    return true
  })
}

/** How many unrecorded decisions a gate tolerates before it stops listening (the run stays waiting). */
const MAX_IGNORED_DECISIONS = 20

function readRecordedDecision(runId: string, block: PlannedBlock): { decision: Decision; note: string | null; approvalId: string } | null {
  const node = db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === block.id)
  if (!node) return null
  const decided = takeRecordedDecision(runId, node.id)
  if (decided === null) {
    withTx(tx => {
      appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, text: strings.gate.ignoredEvent } }, tx)
    })
  }
  return decided
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
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get()
  return {
    providerId: run.providerId,
    request: run.request,
    blocks,
    repoPath: project?.repoPath ?? null,
    testCommand: project?.testCommand ?? null,
    autoApproveLowRisk: project?.autoApproveLowRisk ?? false,
    previousRequest: run.parentRunId ? (db.select({ r: runs.request }).from(runs).where(eq(runs.id, run.parentRunId)).get()?.r ?? null) : null,
  }
}

// The run's working copy, made once before any block runs. A provider that touches no files (the demo) gets none. If the
// copy cannot be made, the run fails with that sentence rather than letting an agent start somewhere else.
function prepareWorkspace(runId: string, plan: Plan, deps: ExecutorDeps): Workspace | { failed: string } {
  const provider = deps.resolveProvider(plan.providerId)
  if (!provider.needsWorkspace) return { workdir: null, testCommand: plan.testCommand, baseCommit: null }
  const existing = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (existing?.worktreePath) return { workdir: existing.worktreePath, testCommand: plan.testCommand, baseCommit: existing.baseCommit }
  if (!plan.repoPath) return { failed: strings.run.noRepository }
  try {
    // A follow-up starts from its parent's approved commit, recorded as its base when it was created.
    const startPoint = existing?.parentRunId ? (existing.baseCommit ?? undefined) : undefined
    const make = deps.createWorktree ?? ((r: string, id: string, sp?: string) => createRunWorktree(r, id, undefined, sp))
    const ws = make(plan.repoPath, runId, startPoint)
    withTx(tx => {
      tx.update(runs).set({ worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }).where(eq(runs.id, runId)).run()
      appendEventSync({ runId, type: 'run.workspace', payload: { branch: ws.branch, path: ws.path, baseCommit: ws.baseCommit } }, tx)
    })
    return { workdir: ws.path, testCommand: plan.testCommand, baseCommit: ws.baseCommit }
  } catch (e) {
    return { failed: strings.run.workspaceFailed(clip(redact(e instanceof Error ? e.message : String(e)), 300)) }
  }
}

// Deliberately tolerant: it never reads run.created, so a run missing that event still executes.
export async function orchestrateRun(runId: string, step: StepApi, deps: ExecutorDeps = defaultDeps): Promise<void> {
  const plan = await step.run('plan', () => loadPlan(runId))
  const started = await step.run('start', () => startRun(runId))
  if (!started) return // cancelled (or already finished) before it began

  const workspace = await step.run('workspace', () => prepareWorkspace(runId, plan, deps))
  if ('failed' in workspace) {
    await step.run('fail', () => finishRun(runId, 'failed', { cause: 'workspace_failed', message: workspace.failed }))
    return
  }
  const prepared: Workspace = { ...workspace, previousRequest: plan.previousRequest }
  const provider = deps.resolveProvider(plan.providerId)

  // Rounds: the first walks every block; when the person asks for changes, the next round walks again from the
  // builder, in the same worktree, with their note. Step ids carry the round so Inngest memoises each round apart
  // (round 1 keeps the original ids, so a run already in flight replays unchanged).
  let round = 1
  let revisionNote: string | null = null
  // Round 1 sees the images sent with the request; a later round sees only those sent with its request for changes.
  let revisionImages: string[] = await step.run('images', () => imagePathsFor(runId))
  let from = 0
  rounds: while (true) {
  const id = (name: string) => (round === 1 ? name : `${name}-r${round}`)
  for (let index = from; index < plan.blocks.length; index++) {
    const block = plan.blocks[index]!
    let result: Outcome
    const route = block.kind === 'human' ? undefined : provider.route?.(block.kind, { testCommand: prepared.testCommand })
    if (!block.enabled) {
      result = await step.run(id(`node-${block.id}`), () => skipNode(runId, block))
    } else if (route?.mode === 'skip') {
      result = await step.run(id(`node-${block.id}`), () => skipNode(runId, block, route.reason))
    } else if (block.kind === 'human') {
      // A run that changed files is measured before the gate, so the card can say what it would be waved through or
      // stopped for. It passes on its own only when the person turned that on and the measurement says low risk.
      const risk = prepared.workdir && prepared.baseCommit ? await step.run(id(`assess-${block.id}`), () => assessGate(runId, block, prepared)) : null
      if (risk?.level === 'low' && plan.autoApproveLowRisk) {
        result = await step.run(id(`node-${block.id}`), () => passLowRiskGate(runId, block))
      } else {
        result = await step.run(id(`node-${block.id}`), () => parkHumanNode(runId, block))
      }
      if (result.outcome === 'parked') {
        // The event only says "look": what was decided is read from the approvals table, where the app records the
        // person's decision before sending it. An event with no record behind it (sent by anything else) is noted
        // and ignored, and the gate keeps waiting.
        let decided: { decision: Decision; note: string | null; approvalId: string } | null = null
        for (let attempt = 0; attempt < MAX_IGNORED_DECISIONS && decided === null; attempt++) {
          // The first wait keeps the id it had before decisions were read from records, so a run parked under that
          // code still resumes after an update. Changing a step id under a parked run makes it wait for a second event.
          const waitId = attempt === 0 ? `approval-${block.id}` : `approval-${block.id}-${attempt}`
          const arrived = await step.waitForEvent(id(waitId), {
            event: APPROVAL_DECIDED,
            timeout: APPROVAL_WAIT,
            match: 'data.runId',
          })
          // No decision (the wait expired) leaves the run waiting on the person; it is never a verdict.
          if (!arrived) return
          decided = await step.run(id(`read-decision-${block.id}-${attempt}`), () => readRecordedDecision(runId, block))
        }
        if (decided === null) return
        if (decided.decision === 'changes' && round <= MAX_REVISIONS) {
          // Back to the builder, in the same worktree, with the note. Everything from the builder to here is redone.
          const builder = plan.blocks.findIndex(b => b.kind === 'build' && b.enabled)
          const start = builder === -1 ? index : builder
          const next = round + 1
          const note = decided.note
          const reopened = await step.run(id(`reopen-${block.id}`), () => reopenForRevision(runId, plan.blocks.slice(start, index + 1), next, note))
          if (!reopened) return // cancelled meanwhile
          round = next
          revisionNote = note
          revisionImages = await step.run(id(`images-${block.id}`), () => imagePathsFor(runId, decided!.approvalId))
          from = start
          continue rounds
        }
        const approved = decided.decision === 'approved'
        result = await step.run(id(`decide-${block.id}`), () => decideHumanNode(runId, block, approved))
      }
    } else {
      const note = revisionNote
      const images = revisionImages
      result = await step.run(id(`node-${block.id}`), () => runProviderNode(runId, plan, block, deps, prepared, note, images))
    }
    if (result.outcome === 'cancelled') return // run.cancelled and node.cancelled were written by cancelRun
    if (result.outcome === 'failed') {
      await step.run(id('fail'), () => finishRun(runId, 'failed', { blockId: block.id }))
      return
    }
  }
  break
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

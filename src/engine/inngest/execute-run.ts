import { classifyArea, routeModel, wantsRouting, type Area } from '@/engine/model-routing'
import { defaultReviewerModel, reviewRevisionNote, type Review } from '@/engine/review'
import { giveRules } from '@/engine/memory'
import { markWaiting } from '@/engine/relay'
import { currentPlan, planDecision, type Job, type PlanDecision } from '@/engine/plan'
import { and, desc, eq } from 'drizzle-orm'
import { NonRetriableError } from 'inngest'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { claims, events, evidence, nodeRuns, projects, runs, usageRecords, workflowVersions } from '@/db/schema'
import { STAGE_ORDER, type BlockKind, type Graph } from '@/domain/graph'
import { canReopen, canTransition, rollUpRunStatus, type NodeState, type RunStatus } from '@/domain/states'
import { appendEventSync, lockRun, type DbHandle, type EventType } from '@/engine/events'
import { APPROVAL_DECIDED, PLAN_DECIDED, inngest, RUN_REQUESTED } from '@/engine/inngest/client'
import { clip, redact } from '@/engine/redact'
import { changeUnderReview, MAX_REVISIONS, NO_CHANGE, takeRecordedDecision, type Decision } from '@/engine/approvals'
import { imagePathsFor } from '@/engine/attachments'
import { assessRisk, type RiskAssessment, type TestFacts } from '@/engine/risk'
import { copyBaseInto, type BaseCopy } from '@/engine/base'
import { installCommandFor, installDependencies, type InstallResult } from '@/engine/install'
import type { TestRun } from '@/engine/test-runner'
import { createRunWorktree, type RunWorkspace } from '@/engine/worktree'
import { claudeProvider } from '@/providers/claude'
import { CLAUDE_PROVIDER_ID, DEMO_PROVIDER_ID } from '@/providers/ids'
import { demoProvider } from '@/providers/demo'
import type { AgentProvider } from '@/providers/types'
import { strings } from '@/ui/strings'
import { projectHere, setLocal } from '@/engine/machine'

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
  createWorktree?: (repoPath: string, runId: string, startPoint?: string, request?: string) => RunWorkspace
  /** Reads whether a request is front end or back end, for a block with a model per area. */
  classifyArea?: (request: string) => Promise<Area | null>
  /** Installs the project's dependencies in the run's copy, once, before the builder starts. */
  installDependencies?: (dir: string) => Promise<InstallResult | null>
  /** Copies the project's prepared base's dependencies into the run's copy instead, when its lockfile matches. */
  copyBase?: (runId: string, dir: string) => Promise<BaseCopy>
}

const defaultDeps: ExecutorDeps = {
  resolveProvider: id => {
    if (id === DEMO_PROVIDER_ID) return demoProvider
    if (id === CLAUDE_PROVIDER_ID) return claudeProvider
    throw new NonRetriableError(`Unknown provider ${id}`)
  },
  createWorktree: (repo, runId, startPoint, request) => createRunWorktree(repo, runId, undefined, startPoint, request),
  installDependencies,
  copyBase: async (runId, dir) => {
    const projectId = (await db.select({ p: runs.projectId }).from(runs).where(eq(runs.id, runId)))[0]?.p
    return projectId ? (await copyBaseInto(projectId, dir)) : { copied: false, reason: 'no-base' }
  },
}

const MAX_LISTED_FILES = 20
/** A step line is short: it says what the agent is doing, it is not a log. */
const STEP_MAX = 240

type PlannedBlock = {
  id: string
  kind: BlockKind
  enabled: boolean
  timeoutMs: number
  model?: string
  /** Models for front-end and back-end work, chosen by what the request is about (see model-routing). */
  modelFrontend?: string
  modelBackend?: string
  /** Set once the area is known: the sentence saying which model was chosen and why, shown on the card. */
  routeNote?: string
  /** A Tests block's own command (lint, build, typecheck…); without one it runs the project's test command. */
  testCommand?: string
}
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
  /** Picking up a failed run whose plan was already checked: the plan is not made or asked about again. */
  skipPlan?: boolean
}
/** What a block's execution may touch: the run's worktree (null for the demo) and the project's test command. */
type Workspace = {
  workdir: string | null
  testCommand: string | null
  baseCommit: string | null
  previousRequest?: string | null
  /** Who asked for this round's changes, when it is a later round. */
  revisionFrom?: 'person' | 'reviewer'
  /** The plan the person checked, for the builder. */
  jobs?: Job[]
  /** The project's rules this task was given when it started. */
  notes?: string[]
}
type Outcome = { outcome: 'passed' | 'failed' | 'cancelled' | 'skipped' | 'parked'; review?: Review }

const now = () => new Date().toISOString()

// ---- atomic state writes: the row change and its event commit together or not at all --------------------------

// Every write about a run holds that run's lock first, until the transaction ends: two writers on one run (the
// executor and a cancel, say) take turns, always in the same order, so they can neither interleave nor deadlock.
function withTx<T>(runId: string, fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await lockRun(tx, runId)
    return fn(tx)
  })
}

async function runStatusOf(h: DbHandle, runId: string): Promise<string | undefined> {
  return (await h.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)))[0]?.s
}

async function isCancelled(runId: string): Promise<boolean> {
  return (await runStatusOf(db, runId)) === 'cancelled'
}

// queued -> running. Returns false when the run was cancelled (or already finished) before it began.
async function startRun(runId: string): Promise<boolean> {
  return withTx(runId, async tx => {
    const status = (await runStatusOf(tx, runId))
    if (status === 'running') return true // replay after a crash: already started
    if (status !== 'queued') return false
    await tx.update(runs).set({ status: 'running', startedAt: now() }).where(eq(runs.id, runId))
    await appendEventSync({ runId, type: 'run.started' }, tx)
    return true
  })
}

// Moves the run to a status that is not terminal (running / waiting_approval) and appends the event for it.
async function setRunStatus(runId: string, status: RunStatus, event: { type: EventType; payload?: unknown }): Promise<void> {
  await withTx(runId, async tx => {
    const current = (await runStatusOf(tx, runId))
    if (current === 'cancelled' || current === 'failed' || current === 'completed') return
    if (current !== status) await tx.update(runs).set({ status }).where(eq(runs.id, runId))
    await appendEventSync({ runId, type: event.type, payload: event.payload } as Parameters<typeof appendEventSync>[0], tx)
  })
}

async function finishRun(runId: string, status: 'completed' | 'failed', payload?: unknown): Promise<void> {
  await withTx(runId, async tx => {
    const current = (await runStatusOf(tx, runId))
    if (current === 'cancelled' || current === 'failed' || current === 'completed') return
    await tx.update(runs).set({ status, finishedAt: now() }).where(eq(runs.id, runId))
    // A failed run will never start the blocks it did not reach, so they end as cancelled rather than read queued.
    if (status === 'failed') (await cancelUnreachedNodes(tx, runId))
    await appendEventSync({ runId, type: status === 'completed' ? 'run.completed' : 'run.failed', payload }, tx)
  })
}

type NodeRow = typeof nodeRuns.$inferSelect

// Writes a node state change plus its event. A change the state machine forbids (for example resurrecting a node
// that cancelRun already cancelled) is refused and nothing is written.
async function transitionNode(
  tx: DbHandle,
  node: NodeRow,
  to: NodeState,
  event: { type: EventType; payload?: Record<string, unknown> },
  fields: Partial<Pick<NodeRow, 'summary' | 'failureCause'>> = {},
): Promise<boolean> {
  if (!canTransition(node.state as NodeState, to)) return false
  const terminal = to === 'passed' || to === 'failed' || to === 'skipped' || to === 'cancelled'
  await tx.update(nodeRuns)
    .set({ state: to, ...fields, ...(terminal ? { finishedAt: now() } : {}) })
    .where(eq(nodeRuns.id, node.id))
    
  await appendEventSync(
    { runId: node.runId, nodeRunId: node.id, type: event.type, payload: { blockId: node.blockId, ...event.payload } } as Parameters<typeof appendEventSync>[0],
    tx,
  )
  node.state = to
  return true
}

// Every block still queued when its run has failed was never reached and never will be.
async function cancelUnreachedNodes(tx: DbHandle, runId: string): Promise<void> {
  for (const node of (await tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))) {
    if (node.state === 'queued') (await transitionNode(tx, node, 'cancelled', { type: 'node.cancelled', payload: { reason: strings.run.notReached } }))
  }
}

// Finds this block's node run or creates it. Refuses (null) once the run is cancelled, inside the same transaction,
// so a node cannot slip in after cancelRun swept the existing ones.
async function openNodeIn(tx: DbHandle, runId: string, blockId: string): Promise<NodeRow | null> {
  if ((await runStatusOf(tx, runId)) === 'cancelled') return null
  const existing = (await tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === blockId)
  if (existing) return existing
  const run = (await tx.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return null
  const row = (await tx
    .insert(nodeRuns)
    .values({ id: ulid(), projectId: run.projectId, runId, blockId, state: 'queued', attempt: 1 })
    .returning()
    )[0]!
  // A row the canvas can see has an event: node.queued commits in the same transaction as the insert.
  await appendEventSync({ runId, nodeRunId: row.id, type: 'node.queued', payload: { blockId } }, tx)
  return row
}

// Read through the transaction when there is one: outside it, its own writes are not visible yet.
async function freshNode(id: string, h: DbHandle = db): Promise<NodeRow> {
  const row = (await h.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]
  if (!row) throw new Error(`node run ${id} vanished`)
  return row
}

function outcomeOf(state: string): Outcome['outcome'] | null {
  if (state === 'passed' || state === 'failed' || state === 'cancelled' || state === 'skipped') return state
  return null
}

// ---- one provider attempt, raced against the timeout and against cancellation ----------------------------------

type Done = { summary: string; source: 'provider' | 'system'; tokens: number | null | undefined; review?: Review; plan?: Job[] }
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
  // Awaited before the next event is read: steps are written in the order the agent said them.
  onStep: (text: string) => Promise<void> | void,
  onEvidence: (data: TestRun) => void,
): Promise<AttemptResult> {
  const controller = new AbortController()
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  // These two settle on their own clocks, so a provider that yields nothing cannot hold the node forever.
  const guard = new Promise<AttemptResult>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), block.timeoutMs)
    poll = setInterval(async () => {
      if ((await isCancelled(runId))) resolve({ kind: 'cancelled' })
    }, CANCEL_POLL_MS)
  })

  const consume = (async (): Promise<AttemptResult> => {
    try {
      const input = {
        blockKind: block.kind,
        request,
        workdir: workspace.workdir ?? undefined,
        testCommand: block.testCommand ?? workspace.testCommand,
        baseCommit: workspace.baseCommit ?? undefined,
        revisionNote: revisionNote ?? undefined,
        ...(revisionNote ? { revisionFrom: workspace.revisionFrom ?? 'person' } : {}),
        previousRequest: workspace.previousRequest ?? undefined,
        images: images.length > 0 ? [...images] : undefined,
        model: block.model,
        ...(block.kind === 'build' && workspace.jobs ? { jobs: workspace.jobs } : {}),
        ...((block.kind === 'build' || block.kind === 'plan') && workspace.notes && workspace.notes.length > 0 ? { notes: workspace.notes } : {}),
      }
      for await (const ev of provider.execute(input, { signal: controller.signal })) {
        if (closed) return { kind: 'ended' } // the node already ended; a late step must not be recorded
        if (ev.type === 'step') await onStep(ev.text)
        else if (ev.type === 'evidence') onEvidence(ev.data)
        else if (ev.type === 'done') return { kind: 'done', summary: ev.summary, source: ev.source ?? 'provider', tokens: ev.usage?.tokens, ...(ev.review ? { review: ev.review } : {}), ...(ev.plan ? { plan: ev.plan } : {}) }
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

async function skipNode(runId: string, block: PlannedBlock, reason: string = strings.run.skippedDisabled): Promise<Outcome> {
  return withTx(runId, async tx => {
    const node = (await openNodeIn(tx, runId, block.id))
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    await transitionNode(tx, node, 'skipped', { type: 'node.skipped', payload: { reason } })
    return { outcome: 'skipped' }
  })
}

// Evidence: the full record (with the redacted output tail) goes to its own table; the event carries numbers only, so
// the browser never receives command output. Written inside the transaction that ends the attempt, so a measurement
// and the block's result are stored together or not at all: a crash in between cannot leave a measurement whose
// block then re-runs and measures again.
async function writeEvidence(tx: DbHandle, node: NodeRow, blockId: string, measured: readonly TestRun[]): Promise<void> {
  if (node.state !== 'running') return
  const { runId, id: nodeRunId } = node
  for (const data of measured) {
    await tx.insert(evidence)
      .values({ id: ulid(), projectId: node.projectId, runId, nodeRunId, kind: 'test_run', source: 'test-runner', dataJson: JSON.stringify(data), createdAt: now() })
      
    await appendEventSync(
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
async function recordDoneFacts(tx: DbHandle, node: NodeRow, done: Done): Promise<void> {
  if (done.tokens !== undefined) {
    await tx.insert(usageRecords).values({ id: ulid(), projectId: node.projectId, nodeRunId: node.id, tokens: done.tokens, costCents: null, createdAt: now() })
  }
  if (done.source !== 'system' && done.summary.trim() !== '') {
    await tx.insert(claims).values({ id: ulid(), projectId: node.projectId, runId: node.runId, nodeRunId: node.id, text: done.summary, createdAt: now() })
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
  const opened = (await withTx(runId, async (tx): Promise<NodeRow | Outcome> => {
    const node = (await openNodeIn(tx, runId, block.id))
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled } // replay of a step that already finished
    if (node.state === 'queued') {
      if (!(await transitionNode(tx, node, 'running', { type: 'node.started', payload: { attempt: node.attempt } }))) {
        return { outcome: 'cancelled' }
      }
      await tx.update(nodeRuns).set({ startedAt: now() }).where(eq(nodeRuns.id, node.id))
      // Which model was chosen for this request, and why: first on the card, before the agent's own steps.
      if (block.routeNote) {
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt: node.attempt, text: block.routeNote } }, tx)
      }
    }
    return node
  }))
  if ('outcome' in opened) return opened

  // The copy is a fresh worktree, without node_modules: install once, before the first build, so the agent and the
  // tests work against the project's real dependencies. A failed install is said on the card; the run carries on.
  if (block.kind === 'build' && workspace.workdir && deps.installDependencies && !(await alreadyInstalled(runId))) {
    await prepareDependencies(runId, opened, block, workspace.workdir, deps.installDependencies, deps.copyBase)
  }

  for (let attempt = (await freshNode(opened.id)).attempt; attempt <= MAX_ATTEMPTS; attempt++) {
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
      async text => {
        await withTx(runId, async tx => {
          const node = (await freshNode(opened.id, tx))
          // Everything a real agent prints is cleaned here, before it can reach the log or the browser.
          const clean = clip(redact(text), STEP_MAX)
          if (node.state === 'running') {
            await appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt, text: clean } }, tx)
          }
        })
      },
      data => measured.push(data),
    )

    if (result.kind === 'cancelled') return { outcome: 'cancelled' }

    if (result.kind === 'done' && block.kind === 'plan' && result.plan) {
      // A proposed plan is not a finished block: it waits for the person, who checks it before anything is built.
      const jobs = result.plan
      const parked = (await withTx(runId, async tx => {
        const node = (await freshNode(opened.id, tx))
        if (node.state !== 'running') return false
        await recordDoneFacts(tx, node, result)
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.planned', payload: { blockId: block.id, jobs, by: 'planner' } }, tx)
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.plan_proposed', payload: { blockId: block.id, summary: result.summary, count: jobs.length } }, tx)
        if ((await runStatusOf(tx, runId)) === 'running') {
          await tx.update(runs).set({ status: 'waiting_approval' }).where(eq(runs.id, runId))
          await appendEventSync({ runId, type: 'run.waiting_approval', payload: { blockId: block.id } }, tx)
        }
        await tx.update(nodeRuns).set({ summary: result.summary }).where(eq(nodeRuns.id, node.id))
        return transitionNode(tx, node, 'waiting_approval', { type: 'node.waiting_approval', payload: { summary: result.summary, summarySource: result.source } })
      }))
      return parked ? { outcome: 'parked' } : { outcome: 'cancelled' }
    }

    if (result.kind === 'done') {
      const done = (await withTx(runId, async tx => {
        const node = (await freshNode(opened.id, tx))
        if (!canTransition(node.state as NodeState, 'passed')) return false
        await writeEvidence(tx, node, block.id, measured)
        const moved = (await transitionNode(tx, node, 'passed', {
          type: 'node.completed',
          payload: {
            summary: result.summary,
            summarySource: result.source,
            attempt,
            // Present only when the provider said something about usage; null inside means "not reported".
            ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
          },
        }, { summary: result.summary }))
        if (!moved) return false
        await recordDoneFacts(tx, node, result)
        // A reviewer's verdict and findings, on the record: the loop reads it to decide whether Build goes again.
        if (result.review) {
          await appendEventSync({ runId, nodeRunId: node.id, type: 'node.reviewed', payload: { blockId: block.id, verdict: result.review.verdict, findings: result.review.findings } }, tx)
        }
        return true
      }))
      return done ? { outcome: 'passed', ...(result.review ? { review: result.review } : {}) } : { outcome: 'cancelled' }
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
      await withTx(runId, async tx => {
        const node = (await freshNode(opened.id, tx))
        if (node.state !== 'running') return
        await writeEvidence(tx, node, block.id, measured)
        await tx.update(nodeRuns).set({ attempt: attempt + 1 }).where(eq(nodeRuns.id, node.id))
        await appendEventSync(
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

    const failed = (await withTx(runId, async tx => {
      const node = (await freshNode(opened.id, tx))
      if (!canTransition(node.state as NodeState, 'failed')) return false
      await writeEvidence(tx, node, block.id, measured)
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
    }))
    return { outcome: failed ? 'failed' : 'cancelled' }
  }
  return { outcome: 'failed' } // unreachable: the loop always returns
}

// What the tests of this run measured, read back from its evidence: the gate is judged on records, not on a summary.
async function alreadyInstalled(runId: string): Promise<boolean> {
  return (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.installed'))))[0] !== undefined
}

async function prepareDependencies(
  runId: string,
  node: NodeRow,
  block: PlannedBlock,
  dir: string,
  install: (dir: string) => Promise<InstallResult | null>,
  copyBase?: (runId: string, dir: string) => Promise<BaseCopy>,
): Promise<void> {
  const step = (text: string, tx: DbHandle) =>
    appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt: node.attempt, text } }, tx)
  const command = installCommandFor(dir)
  if (!command) return
  // The project's prepared base, when this copy's lockfile is the one it was installed from: copied, not installed.
  const copied = copyBase ? await copyBase(runId, dir) : undefined
  if (copied?.copied) {
    await withTx(runId, async tx => {
      await step(strings.run.copiedFromBase(Math.max(1, Math.round(copied.ms / 1000))), tx)
      await appendEventSync({ runId, type: 'run.installed', payload: { command, ok: true, fromBase: true } }, tx)
    })
    return
  }
  await withTx(runId, tx => step(copied && copied.reason === 'different-lockfile' ? strings.run.installingChanged(command) : strings.run.installing(command), tx))
  const result = await install(dir)
  await withTx(runId, async tx => {
    if (result) {
      const seconds = Math.max(1, Math.round(result.durationMs / 1000))
      await step(result.ok ? strings.run.installed(seconds) : strings.run.installFailed(clip(redact(result.outputTail).trim().split('\n').slice(-2).join(' '), 200)), tx)
    }
    await appendEventSync({ runId, type: 'run.installed', payload: { command, ok: result?.ok ?? false } }, tx)
  })
}

/** A command written on a Tests block: one line, of a sane length, or none at all. */
function ownCommand(b: { kind: string; config: Record<string, unknown> }): { testCommand?: string } {
  const v = b.config.testCommand
  if (b.kind !== 'tests' || typeof v !== 'string') return {}
  const command = v.trim()
  return command !== '' && command.length <= 500 && !/[\r\n\0]/.test(command) ? { testCommand: command } : {}
}

async function testFactsOf(runId: string): Promise<TestFacts> {
  // The latest test run of each block: an earlier round's result says nothing about the change as it is now.
  const latest = new Map<string, { createdAt: string; id: string; data: TestRun }>()
  for (const e of (await db.select().from(evidence).where(eq(evidence.runId, runId)))) {
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
    reviewOpen: (await latestReview(runId)) === 'changes',
  }
}

async function assessGate(runId: string, block: PlannedBlock, workspace: Workspace): Promise<RiskAssessment | null> {
  if (!workspace.workdir || !workspace.baseCommit) return null
  // The change as it stands now, recorded for any computer that shows the gate (and binds a decision to its hash).
  await changeUnderReview(runId).catch(() => null) // unreadable now: the gate reads it again when shown
  const assessment = assessRisk(workspace.workdir, workspace.baseCommit, (await testFactsOf(runId)))
  await withTx(runId, async tx => {
    const node = (await openNodeIn(tx, runId, block.id))
    if (!node || outcomeOf(node.state)) return
    await appendEventSync(
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
/** How many times a reviewer may send the work back to the builder before it goes to the person as it is. */
const MAX_REVIEW_ROUNDS = 2

/** The latest verdict any reviewer recorded on this run, or null when none did. */
async function latestReview(runId: string): Promise<'ok' | 'changes' | null> {
  const rows = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'node.reviewed'))).orderBy(desc(events.sequence)))
  const verdict = rows[0] ? (JSON.parse(rows[0].payloadJson) as { verdict?: string }).verdict : null
  return verdict === 'ok' || verdict === 'changes' ? verdict : null
}

// Approve, for the real agent: a plain summary, from the record, of what the reviewers concluded. It always passes:
// the final yes is the person's, at the human check.
async function sumUpReviews(runId: string, block: PlannedBlock, sentBack: number): Promise<Outcome> {
  const latest = (await latestReview(runId))
  const summary =
    latest === null
      ? strings.review.approve.none
      : latest === 'changes'
        ? strings.review.approve.open
        : sentBack > 0
          ? strings.review.approve.fixed(sentBack)
          : strings.review.approve.clean
  return withTx(runId, async (tx): Promise<Outcome> => {
    const node = (await openNodeIn(tx, runId, block.id))
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    if (node.state === 'queued') {
      if (!(await transitionNode(tx, node, 'running', { type: 'node.started', payload: { attempt: node.attempt } }))) return { outcome: 'cancelled' }
      await tx.update(nodeRuns).set({ startedAt: now() }).where(eq(nodeRuns.id, node.id))
    }
    const passed = (await transitionNode(tx, node, 'passed', { type: 'node.completed', payload: { summary, summarySource: 'system' } }, { summary }))
    return { outcome: passed ? 'passed' : 'cancelled' }
  })
}

async function passLowRiskGate(runId: string, block: PlannedBlock): Promise<Outcome> {
  return withTx(runId, async (tx): Promise<Outcome> => {
    const node = (await openNodeIn(tx, runId, block.id))
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    if (node.state === 'queued') {
      if (!(await transitionNode(tx, node, 'running', { type: 'node.started', payload: { attempt: node.attempt } }))) return { outcome: 'cancelled' }
      await tx.update(nodeRuns).set({ startedAt: now() }).where(eq(nodeRuns.id, node.id))
    }
    const passed = (await transitionNode(
      tx,
      node,
      'passed',
      { type: 'node.completed', payload: { summary: strings.risk.passedLow, summarySource: 'system', autoApproved: true } },
      { summary: strings.risk.passedLow },
    ))
    return { outcome: passed ? 'passed' : 'cancelled' }
  })
}

// The person asked for changes: every block from the builder to the human check goes back to queued for the next
// round, in one transaction, each with a node.reopened event carrying the round and the person's note. Blocks that
// were skipped stay skipped. The run is running again. Nothing in the worktree is touched: the next round builds on it.
async function reopenForRevision(
  runId: string,
  blocks: readonly PlannedBlock[],
  round: number,
  note: string | null,
  by: 'person' | 'reviewer' = 'person',
): Promise<boolean> {
  return withTx(runId, async tx => {
    // The person sends work back from the gate, where the run waits; a reviewer does it while the run is still going.
    const status = (await runStatusOf(tx, runId))
    if (status !== (by === 'person' ? 'waiting_approval' : 'running')) return false
    const clean = note ? clip(redact(note), 500) : null
    for (const block of blocks) {
      const node = (await tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === block.id)
      if (!node || !canReopen(node.state as NodeState)) continue
      await tx.update(nodeRuns)
        .set({ state: 'queued', attempt: 1, summary: null, failureCause: null, startedAt: null, finishedAt: null })
        .where(eq(nodeRuns.id, node.id))
        
      await appendEventSync({ runId, nodeRunId: node.id, type: 'node.reopened', payload: { blockId: block.id, round, note: clean, by } }, tx)
    }
    if (by === 'person') {
      await tx.update(runs).set({ status: 'running' }).where(eq(runs.id, runId))
      await appendEventSync({ runId, type: 'run.started', payload: { resumed: true, round } }, tx)
    }
    return true
  })
}

/** How many unrecorded decisions a gate tolerates before it stops listening (the run stays waiting). */
const MAX_IGNORED_DECISIONS = 20

async function readRecordedDecision(runId: string, block: PlannedBlock): Promise<{ decision: Decision; note: string | null; approvalId: string } | null> {
  const node = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === block.id)
  if (!node) return null
  const decided = (await takeRecordedDecision(runId, node.id))
  const note = async (text: string) =>
    withTx(runId, async tx => {
      await appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, text } }, tx)
    })
  if (decided === null) {
    await note(strings.gate.ignoredEvent)
    return null
  }
  // Checked here, against the working copy itself: a decision about a change other than the one there now (made on
  // another computer, on an older view) decides nothing, and the gate keeps waiting.
  const live = (await changeUnderReview(runId))?.hash ?? NO_CHANGE
  if (decided.diffHash !== null && decided.diffHash !== live) {
    await note(strings.gate.staleDecision)
    return null
  }
  return { decision: decided.decision, note: decided.note, approvalId: decided.approvalId }
}

// A human block never calls a provider: it records that it is waiting and the function parks.
async function parkHumanNode(runId: string, block: PlannedBlock): Promise<Outcome> {
  const result = (await withTx(runId, async (tx): Promise<Outcome> => {
    const node = (await openNodeIn(tx, runId, block.id))
    if (!node) return { outcome: 'cancelled' }
    const settled = outcomeOf(node.state)
    if (settled) return { outcome: settled }
    if (node.state === 'queued') {
      if (!(await transitionNode(tx, node, 'running', { type: 'node.started', payload: { attempt: node.attempt } }))) return { outcome: 'cancelled' }
      await tx.update(nodeRuns).set({ startedAt: now() }).where(eq(nodeRuns.id, node.id))
    }
    // The run's own state change is an event too, appended where the status changes. It precedes the node event so
    // the log ends on node.waiting_approval, the block the person has to act on.
    if ((await runStatusOf(tx, runId)) === 'running') {
      await tx.update(runs).set({ status: 'waiting_approval' }).where(eq(runs.id, runId))
      await appendEventSync({ runId, type: 'run.waiting_approval', payload: { blockId: block.id } }, tx)
    }
    if (node.state === 'running' && !(await transitionNode(tx, node, 'waiting_approval', { type: 'node.waiting_approval' }))) return { outcome: 'cancelled' }
    return { outcome: 'parked' }
  }))
  return result
}

async function decideHumanNode(runId: string, block: PlannedBlock, approved: boolean): Promise<Outcome> {
  const node = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === block.id)
  if (!node) return { outcome: 'cancelled' }
  const ok = (await withTx(runId, async tx => {
    const fresh = (await freshNode(node.id, tx))
    const moved = approved
      ? (await transitionNode(tx, fresh, 'passed', { type: 'node.completed', payload: { summary: strings.run.resumed, summarySource: 'system' } }, { summary: strings.run.resumed }))
      : (await transitionNode(tx, fresh, 'failed', { type: 'node.failed', payload: { cause: 'rejected', message: strings.run.rejected, messageSource: 'system' } }, { failureCause: 'rejected' }))
    if (moved && (await runStatusOf(tx, runId)) === 'waiting_approval') {
      await tx.update(runs).set({ status: 'running' }).where(eq(runs.id, runId))
      await appendEventSync({ runId, type: 'run.started', payload: { resumed: true } }, tx)
    }
    return moved
  }))
  return { outcome: ok ? (approved ? 'passed' : 'failed') : 'cancelled' }
}

// The person said build it: the plan block passes with the jobs they checked, and the run goes on.
async function confirmPlanNode(runId: string, block: PlannedBlock): Promise<{ outcome: Outcome['outcome']; jobs?: Job[] }> {
  const jobs = (await currentPlan(runId))?.jobs
  const node = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === block.id)
  if (!node || !jobs) return { outcome: 'cancelled' }
  const summary = strings.plan.confirmed(jobs.length)
  const ok = (await withTx(runId, async tx => {
    const moved = (await transitionNode(tx, (await freshNode(node.id, tx)), 'passed', { type: 'node.completed', payload: { summary, summarySource: 'system' } }, { summary }))
    if (moved && (await runStatusOf(tx, runId)) === 'waiting_approval') {
      await tx.update(runs).set({ status: 'running' }).where(eq(runs.id, runId))
      await appendEventSync({ runId, type: 'run.started', payload: { resumed: true } }, tx)
    }
    return moved
  }))
  return ok ? { outcome: 'passed', jobs } : { outcome: 'cancelled' }
}

/** How many times the person may ask for a new plan on one task. */
const MAX_REPLANS = 5

// ---- the orchestration ---------------------------------------------------------------------------------------------

async function loadPlan(runId: string): Promise<Plan> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) throw new NonRetriableError(`${strings.errors.runNotFound} (${runId})`)
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]
  if (!version) throw new NonRetriableError(`${strings.errors.runNotFound} (${runId})`)
  const graph = JSON.parse(version.graphJson) as Graph
  // Stage order, then the order blocks were added within a stage. Disabled blocks stay in the plan so they are reported.
  const ordered = STAGE_ORDER.flatMap(kind => graph.blocks.filter(b => b.kind === kind))
  const blocks = ordered.map(b => {
    const t = (b.config as { timeoutMs?: unknown }).timeoutMs
    const model = (b.config as { model?: unknown }).model
    const named = (key: 'modelFrontend' | 'modelBackend') => {
      const v = (b.config as Record<string, unknown>)[key]
      return typeof v === 'string' && v.trim() !== '' ? { [key]: v.trim() } : {}
    }
    return {
      id: b.id,
      kind: b.kind,
      enabled: b.enabled,
      timeoutMs: typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_MS,
      // The model written on the block, from the frozen version: what the card shows is what the agent runs with.
      ...(typeof model === 'string' && model.trim() !== '' ? { model: model.trim() } : {}),
      ...named('modelFrontend'),
      ...named('modelBackend'),
      ...ownCommand(b),
    }
  })
  const project = await projectHere(run.projectId)
  return {
    providerId: run.providerId,
    request: run.request,
    blocks,
    repoPath: project?.repoPath ?? null,
    testCommand: project?.testCommand ?? null,
    autoApproveLowRisk: project?.autoApproveLowRisk ?? false,
    previousRequest: run.parentRunId ? ((await db.select({ r: runs.request }).from(runs).where(eq(runs.id, run.parentRunId)))[0]?.r ?? null) : null,
    skipPlan: await planAlreadyMade(runId),
  }
}

async function planAlreadyMade(runId: string): Promise<boolean> {
  const row = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.continues'))).limit(1))[0]
  return row ? (JSON.parse(row.payloadJson) as { skipPlan?: unknown }).skipPlan === true : false
}

/** The commit a run that picks up a failed one starts its files from, or null for any other run. */
async function continuesFrom(runId: string): Promise<string | null> {
  const row = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.continues'))).limit(1))[0]
  const commit = row ? (JSON.parse(row.payloadJson) as { commit?: unknown }).commit : null
  return typeof commit === 'string' && /^[0-9a-f]{7,64}$/.test(commit) ? commit : null
}

// The run's working copy, made once before any block runs. A provider that touches no files (the demo) gets none. If the
// copy cannot be made, the run fails with that sentence rather than letting an agent start somewhere else.
async function prepareWorkspace(runId: string, plan: Plan, deps: ExecutorDeps): Promise<Workspace | { failed: string }> {
  const provider = deps.resolveProvider(plan.providerId)
  if (!provider.needsWorkspace) return { workdir: null, testCommand: plan.testCommand, baseCommit: null }
  const existing = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (existing?.worktreePath) return { workdir: existing.worktreePath, testCommand: plan.testCommand, baseCommit: existing.baseCommit }
  if (!plan.repoPath) return { failed: strings.run.noRepository }
  try {
    // The commit chosen when the run was created: a follow-up's parent's approved commit, or the branch a fresh task
    // starts from (the project's main branch by default). Absent on runs made before that was recorded: the folder's HEAD.
    // A run that picks up a failed one starts from the work that run left, but stays compared against the commit
    // that run started from: nobody approved the work in between, so the human check must show all of it.
    const continues = await continuesFrom(runId)
    const startPoint = continues ?? existing?.baseCommit ?? undefined
    const make = deps.createWorktree ?? ((r: string, id: string, sp?: string, req?: string) => createRunWorktree(r, id, undefined, sp, req))
    // The branch is named after the request, so a person can tell it apart in their own `git branch`.
    const made = make(plan.repoPath, runId, startPoint, plan.request)
    const ws = continues && existing?.baseCommit ? { ...made, baseCommit: existing.baseCommit } : made
    await withTx(runId, async tx => {
      await tx.update(runs).set({ worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }).where(eq(runs.id, runId))
      await appendEventSync({ runId, type: 'run.workspace', payload: { branch: ws.branch, path: ws.path, baseCommit: ws.baseCommit } }, tx)
    })
    return { workdir: ws.path, testCommand: plan.testCommand, baseCommit: ws.baseCommit }
  } catch (e) {
    return { failed: strings.run.workspaceFailed(clip(redact(e instanceof Error ? e.message : String(e)), 300)) }
  }
}

// Rules are for a real agent working on the project; the demo touches nothing and is given none.
function provider_needsRules(plan: Plan): boolean {
  return plan.providerId !== DEMO_PROVIDER_ID
}

// Deliberately tolerant: it never reads run.created, so a run missing that event still executes.
export async function orchestrateRun(runId: string, step: StepApi, deps: ExecutorDeps = defaultDeps): Promise<void> {
  const loaded = await step.run('plan', () => loadPlan(runId))
  // A builder with a model per area: what the request is about is read once, durably, and the choice is fixed for the run.
  const routing = loaded.blocks.some(wantsRouting)
  const area = routing ? await step.run('classify', () => (deps.classifyArea ?? classifyArea)(loaded.request)) : null
  const plan: Plan = routing
    ? {
        ...loaded,
        blocks: loaded.blocks.map(b => {
          if (!wantsRouting(b)) return b
          const routed = routeModel(b, area)
          return { ...b, model: routed.model, routeNote: routed.note }
        }),
      }
    : loaded
  // A reviewer without a model of its own gets one other than the builder's: a second opinion, not an echo.
  const builderModel = plan.blocks.find(b => b.kind === 'build' && b.enabled)?.model
  for (const [i, b] of plan.blocks.entries()) {
    if (b.kind !== 'review') continue
    const model = b.model ?? defaultReviewerModel(builderModel)
    plan.blocks[i] = { ...b, model, routeNote: strings.review.model(model, builderModel ?? strings.routing.defaultModel) }
  }
  // The planner reads and proposes; without a model of its own it uses Sonnet.
  for (const [i, b] of plan.blocks.entries()) {
    if (b.kind !== 'plan') continue
    const model = b.model ?? 'sonnet'
    plan.blocks[i] = { ...b, model, routeNote: strings.plan.model(model) }
  }
  const started = await step.run('start', () => startRun(runId))
  if (!started) return // cancelled (or already finished) before it began

  const workspace = await step.run('workspace', () => prepareWorkspace(runId, plan, deps))
  if ('failed' in workspace) {
    await step.run('fail', () => finishRun(runId, 'failed', { cause: 'workspace_failed', message: workspace.failed }))
    return
  }
  // The project's rules, fixed for this task when it starts: what the person taught on earlier tasks.
  const notes = provider_needsRules(plan) ? await step.run('memory', () => giveRules(runId)) : []
  let prepared: Workspace = { ...workspace, previousRequest: plan.previousRequest, notes }
  const provider = deps.resolveProvider(plan.providerId)

  // Rounds: the first walks every block; when the person asks for changes, the next round walks again from the
  // builder, in the same worktree, with their note. Step ids carry the round so Inngest memoises each round apart
  // (round 1 keeps the original ids, so a run already in flight replays unchanged).
  let round = 1
  let revisionNote: string | null = null
  // Round 1 sees the images sent with the request; a later round sees only those sent with its request for changes.
  let revisionImages: string[] = await step.run('images', () => imagePathsFor(runId))
  let from = 0
  // Rounds the reviewer sent back, and who asked for the round now being built: the builder is told which.
  let reviewRounds = 0
  let revisionFrom: 'person' | 'reviewer' = 'person'
  rounds: while (true) {
  const id = (name: string) => (round === 1 ? name : `${name}-r${round}`)
  for (let index = from; index < plan.blocks.length; index++) {
    const block = plan.blocks[index]!
    let result: Outcome
    const route = block.kind === 'human' ? undefined : provider.route?.(block.kind, { testCommand: block.testCommand ?? prepared.testCommand })
    if (!block.enabled) {
      result = await step.run(id(`node-${block.id}`), () => skipNode(runId, block))
    } else if (route?.mode === 'skip') {
      result = await step.run(id(`node-${block.id}`), () => skipNode(runId, block, route.reason))
    } else if (block.kind === 'plan' && plan.skipPlan) {
      // Picking up a failed task: its plan was checked and built already, so the work goes straight on.
      result = await step.run(id(`node-${block.id}`), () => skipNode(runId, block, strings.plan.alreadyMade))
    } else if (block.kind === 'plan' && provider.needsWorkspace) {
      // The planner proposes; the person checks, edits, and says build it — or asks for another plan with a note.
      let note: string | null = null
      let images = revisionImages
      result = { outcome: 'cancelled' }
      for (let k = 0; k <= MAX_REPLANS; k++) {
        const pid = (name: string) => id(k === 0 ? name : `${name}-plan${k}`)
        const n = note
        const imgs = images
        result = await step.run(pid(`node-${block.id}`), () => runProviderNode(runId, plan, block, deps, prepared, n, imgs))
        if (result.outcome !== 'parked') break // passed without a readable plan (Build works from the request), failed or cancelled
        markWaiting(runId) // the relay watches for a word made on another computer
        let decided: PlanDecision | null = null
        for (let attempt = 0; attempt < MAX_IGNORED_DECISIONS && decided === null; attempt++) {
          const arrived = await step.waitForEvent(pid(`plan-decided-${block.id}-${attempt}`), { event: PLAN_DECIDED, timeout: APPROVAL_WAIT, match: 'data.runId' })
          if (!arrived) return // the wait expired: the run stays waiting on the person
          decided = await step.run(pid(`read-plan-${block.id}-${attempt}`), () => planDecision(runId))
        }
        if (decided === null) return
        if (decided.action === 'build') {
          const confirmed = await step.run(pid(`confirm-${block.id}`), () => confirmPlanNode(runId, block))
          result = { outcome: confirmed.outcome }
          if (confirmed.jobs) prepared = { ...prepared, jobs: confirmed.jobs }
          break
        }
        if (k === MAX_REPLANS) return // asked again more times than allowed: it stays waiting on the person
        const again = decided.note
        const reopened = await step.run(pid(`replan-${block.id}`), () => reopenForRevision(runId, [block], k + 2, again))
        if (!reopened) return
        note = again
        images = []
      }
    } else if (block.kind === 'approve' && provider.needsWorkspace) {
      // The real agent's Approve is a summary of what the reviewers said, never a yes: that stays the person's.
      const rounds = reviewRounds
      result = await step.run(id(`node-${block.id}`), () => sumUpReviews(runId, block, rounds))
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
        markWaiting(runId) // the relay watches for a decision made on another computer
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
          revisionFrom = 'person'
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
      const workspace: Workspace = { ...prepared, revisionFrom }
      result = await step.run(id(`node-${block.id}`), () => runProviderNode(runId, plan, block, deps, workspace, note, images))
      // The reviewer found problems: back to the builder with them, a bounded number of times. After that the problems
      // stay on the record for the person, and the run goes on to them.
      if (block.kind === 'review' && result.outcome === 'passed' && result.review?.verdict === 'changes' && reviewRounds < MAX_REVIEW_ROUNDS) {
        const builder = plan.blocks.findIndex(b => b.kind === 'build' && b.enabled)
        if (builder !== -1 && builder < index) {
          const next = round + 1
          const findings = result.review.findings
          const reviewNote = reviewRevisionNote(findings)
          const reopened = await step.run(id(`reopen-${block.id}`), () => reopenForRevision(runId, plan.blocks.slice(builder, index + 1), next, reviewNote, 'reviewer'))
          if (!reopened) return
          round = next
          reviewRounds += 1
          revisionNote = reviewNote
          revisionFrom = 'reviewer'
          revisionImages = []
          from = builder
          continue rounds
        }
      }
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
  await step.run('finish', async () => {
    const states = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).map(n => n.state as NodeState)
    const status = rollUpRunStatus(states)
    if (status === 'completed') (await finishRun(runId, 'completed'))
    else if (status === 'failed') (await finishRun(runId, 'failed'))
    else if (status === 'waiting_approval') (await setRunStatus(runId, 'waiting_approval', { type: 'run.waiting_approval' }))
    return status
  })
}

// Last resort when a step throws for good (missing run, exhausted retries): nothing may be left running with no
// recorded cause. Unfinished nodes fail, then the run fails, each through the guarded transitions.
export async function failRunAfterError(runId: string): Promise<void> {
  await withTx(runId, async tx => {
    const status = (await runStatusOf(tx, runId))
    if (status === undefined || status === 'cancelled' || status === 'failed' || status === 'completed') return
    for (const node of (await tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))) {
      if (node.state === 'queued') {
        // queued -> failed is not a legal transition; a node that never started is cancelled, and the run carries the failure.
        (await transitionNode(tx, node, 'cancelled', { type: 'node.cancelled', payload: { reason: strings.run.internalFailure } }))
        continue
      }
      (await transitionNode(tx, node, 'failed', {
        type: 'node.failed',
        payload: { cause: 'internal_error', message: strings.run.internalFailure, messageSource: 'system' },
      }, { failureCause: 'internal_error' }))
    }
    await tx.update(runs).set({ status: 'failed', finishedAt: now() }).where(eq(runs.id, runId))
    await appendEventSync({ runId, type: 'run.failed', payload: { cause: 'internal_error', message: strings.run.internalFailure } }, tx)
  })
}

export const executeRun = inngest.createFunction(
  {
    id: 'execute-run',
    triggers: [{ event: RUN_REQUESTED }],
    onFailure: async ({ event }) => {
      const runId = (event.data.event.data as { runId?: unknown }).runId
      if (typeof runId === 'string') (await failRunAfterError(runId))
    },
  },
  async ({ event, step }) => {
    const { runId } = event.data as { runId: string }
    await orchestrateRun(runId, step as unknown as StepApi)
  },
)

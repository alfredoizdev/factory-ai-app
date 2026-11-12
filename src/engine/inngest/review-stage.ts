import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { canTransition, type NodeState } from '@/domain/states'
import { appendEventSync } from '@/engine/events'
import { bySeverity, mergeDuplicates, recordFindings, setFinding, type FindingRow, type FindingState } from '@/engine/findings'
import {
  MAX_ATTEMPTS,
  canRetry,
  describeFailure,
  freshNode,
  openProviderNode,
  outcomeOf,
  recordDoneFacts,
  runAttempt,
  testFactsOf,
  transitionNode,
  withTx,
  type ExecutorDeps,
  type Outcome,
  type Plan,
  type PlannedBlock,
  type StepApi,
  type Workspace,
} from '@/engine/inngest/execute-run'
import { focusesFor, type Finding, type Focus, type Review } from '@/engine/review'
import { clip, redact } from '@/engine/redact'
import { assessRisk } from '@/engine/risk'
import { strings } from '@/ui/strings'

// The Review block, for a provider that works on files: one reader on a small change, three on anything else, each
// looking for one thing. What they report is only a claim; it is checked against the code (findings.ts) before the
// builder is told any of it. One node on the card holds all of it; each reader is a step of its own, so a retry
// never reads twice, and the findings are recorded in a step of their own, once per round.

export type StageResult = { outcome: Outcome['outcome']; sendBack: FindingRow[] }

type Context = {
  runId: string
  plan: Plan
  block: PlannedBlock
  step: StepApi
  /** Gives a step its id for this round. */
  id: (name: string) => string
  deps: ExecutorDeps
  workspace: Workspace
  round: number
  /** A tree id: read only what changed since it, not since the base commit. */
  reviewSince: string | null
}

type Reading = { review: Review | null } | { outcome: 'cancelled' | 'failed' | 'passed' | 'skipped' | 'parked' } | { failed: ReturnType<typeof describeFailure> & { messageSource: 'provider' | 'system'; attempt: number } }

const SUMMARY_MAX = 600

export async function runReviewStage(ctx: Context): Promise<StageResult> {
  const { runId, block, step, id, workspace } = ctx
  const none = (outcome: Outcome['outcome']): StageResult => ({ outcome, sendBack: [] })

  // How deep to read is measured once for the round, from the change as it stands.
  const risk = await step.run(id(`review-depth-${block.id}`), () => depthOf(runId, workspace))
  const focuses = focusesFor(risk)
  const opened = await step.run(id(`review-open-${block.id}`), async () => {
    const node = await openProviderNode(runId, block, [focuses.length === 1 ? strings.review.depth.one : strings.review.depth.three])
    return 'outcome' in node ? node : { nodeId: node.id }
  })
  if ('outcome' in opened) return none(opened.outcome)

  const found: { focus: Focus; finding: Finding }[] = []
  for (const focus of focuses) {
    const reading = await step.run(id(`review-${block.id}-${focus}`), () => readFor(ctx, opened.nodeId, focus))
    if ('outcome' in reading) return none(reading.outcome)
    if ('failed' in reading) {
      // A reader that failed, or changed a file, makes the block fail; nothing any reader said is used.
      const outcome = await step.run(id(`review-fail-${block.id}`), () => failReview(runId, opened.nodeId, reading.failed))
      return none(outcome)
    }
    for (const finding of reading.review?.findings ?? []) found.push({ focus, finding })
  }

  const rows = await step.run(id(`review-found-${block.id}`), () =>
    recordFindings(runId, opened.nodeId, ctx.round, mergeDuplicates(found), workspace.workdir ?? ''),
  )
  const sendBack = bySeverity(rows.filter(r => r.state !== 'refuted'))
  const summary = sendBack.length > 0 ? strings.review.problems(sendBack.length) : rows.length > 0 ? strings.review.noProblemsLeft : strings.review.noProblems
  const outcome = await step.run(id(`review-close-${block.id}`), () => closeReview(runId, opened.nodeId, summary))
  return { outcome, sendBack: outcome === 'passed' ? sendBack : [] }
}

/** After the builder has been told (or cannot be): what became of the findings that held up. */
export async function settleFindings(rows: readonly FindingRow[], state: Extract<FindingState, 'fixed_unchecked' | 'open'>): Promise<void> {
  for (const r of rows) await setFinding(r.id, { state })
}

async function depthOf(runId: string, workspace: Workspace): Promise<'low' | 'high'> {
  // A change that cannot be measured is read as carefully as a risky one.
  if (!workspace.workdir || !workspace.baseCommit) return 'high'
  return assessRisk(workspace.workdir, workspace.baseCommit, await testFactsOf(runId)).level
}

/** What the builder said it did, from the build node's stored sentence. */
async function builderSummaryOf(ctx: Context): Promise<string | undefined> {
  const build = ctx.plan.blocks.find(b => b.kind === 'build' && b.enabled)
  if (!build) return undefined
  const row = (await db.select().from(nodeRuns).where(and(eq(nodeRuns.runId, ctx.runId), eq(nodeRuns.blockId, build.id))))[0]
  return row?.summary ? clip(redact(row.summary), SUMMARY_MAX) : undefined
}

/** One reader: up to MAX_ATTEMPTS tries, its steps on the shared node, its verdict recorded with its focus. */
async function readFor(ctx: Context, nodeId: string, focus: Focus): Promise<Reading> {
  const { runId, plan, block, deps } = ctx
  const provider = deps.resolveProvider(plan.providerId)
  const builderSummary = await builderSummaryOf(ctx)
  const workspace: Workspace = { ...ctx.workspace, review: { focus, ...(builderSummary ? { builderSummary } : {}), ...(ctx.reviewSince ? { since: ctx.reviewSince } : {}) } }
  const say = (text: string, attempt: number, extra: Record<string, unknown> = {}) =>
    withTx(runId, async tx => {
      const node = await freshNode(nodeId, tx)
      if (node.state === 'running') {
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt, text: clip(redact(text), 240), ...extra } }, tx)
      }
    })

  await say(strings.review.reading[focus], 1)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await runAttempt(provider, block, plan.request, runId, workspace, null, [], text => say(text, attempt), () => {})
    if (result.kind === 'cancelled') return { outcome: 'cancelled' }
    if (result.kind === 'done') {
      return withTx(runId, async (tx): Promise<Reading> => {
        const node = await freshNode(nodeId, tx)
        if (node.state !== 'running') return { outcome: outcomeOf(node.state) ?? 'cancelled' }
        await recordDoneFacts(tx, node, result)
        if (result.review) {
          await appendEventSync({ runId, nodeRunId: node.id, type: 'node.reviewed', payload: { blockId: block.id, focus, verdict: result.review.verdict, findings: result.review.findings } }, tx)
        }
        return { review: result.review ?? null }
      })
    }
    const failure = describeFailure(result, block)
    if (canRetry(attempt, result)) {
      await say(strings.run.retrying, attempt + 1, { retry: true, previousCause: failure.cause, previousMessage: failure.message, ...(failure.detail ? { previousDetail: failure.detail } : {}) })
      continue
    }
    return { failed: { ...failure, messageSource: result.kind === 'error' ? result.source : 'system', attempt } }
  }
  return { outcome: 'failed' } // unreachable: the loop always returns
}

async function failReview(runId: string, nodeId: string, f: Extract<Reading, { failed: unknown }>['failed']): Promise<Outcome['outcome']> {
  return withTx(runId, async tx => {
    const node = await freshNode(nodeId, tx)
    const settled = outcomeOf(node.state)
    if (settled) return settled
    if (!canTransition(node.state as NodeState, 'failed')) return 'cancelled'
    const payload = { cause: f.cause, message: f.message, messageSource: f.messageSource, attempt: f.attempt, ...(f.detail ? { detail: f.detail } : {}) }
    return (await transitionNode(tx, node, 'failed', { type: 'node.failed', payload }, { failureCause: f.cause })) ? 'failed' : 'cancelled'
  })
}

async function closeReview(runId: string, nodeId: string, summary: string): Promise<Outcome['outcome']> {
  return withTx(runId, async tx => {
    const node = await freshNode(nodeId, tx)
    const settled = outcomeOf(node.state)
    if (settled) return settled
    if (!canTransition(node.state as NodeState, 'passed')) return 'cancelled'
    return (await transitionNode(tx, node, 'passed', { type: 'node.completed', payload: { summary, summarySource: 'system' } }, { summary })) ? 'passed' : 'cancelled'
  })
}

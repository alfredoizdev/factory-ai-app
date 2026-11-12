import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { findings, nodeRuns } from '@/db/schema'
import { canTransition, type NodeState } from '@/domain/states'
import { appendEventSync } from '@/engine/events'
import { bySeverity, findingsOf, mergeDuplicates, recordFindings, riskOf, setFinding, type FindingRow } from '@/engine/findings'
import { QUESTION_ANSWERED } from '@/engine/inngest/client'
import { LEAVE, askPerson, takeAnswer, type Question } from '@/engine/questions'
import { addEntry, corePaths } from '@/engine/register'
import { makeCopy as realMakeCopy, removeCopy, reproduced, runRepro as realRunRepro, type Repro } from '@/engine/repro'
import {
  APPROVAL_WAIT,
  MAX_ATTEMPTS,
  MAX_IGNORED_DECISIONS,
  isCancelled,
  canRetry,
  describeFailure,
  freshNode,
  openProviderNode,
  outcomeOf,
  recordDoneFacts,
  runAttempt,
  type AttemptResult,
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
import { MAX_FINDINGS, focusesFor, type Finding, type Focus, type Review } from '@/engine/review'
import { clip, redact } from '@/engine/redact'
import { assessRisk } from '@/engine/risk'
import { strings } from '@/ui/strings'

// The Review block, for a provider that works on files: one reader on a small change, three on anything else, each
// looking for one thing. What they report is only a claim; it is checked against the code (findings.ts) before the
// builder is told any of it. One node on the card holds all of it; each reader is a step of its own, so a retry
// never reads twice, and the findings are recorded in a step of their own, once per round.
//
// Every finding that held up is then verified by reproducing it in a throwaway copy, and routed: fixed when it is small
// and safe, put to the person when it touches what matters, dropped when it cannot be shown. Every side effect is a step
// of its own (verify, ask, resolve, fix, each with the finding's id) and writes only if the finding is not already there.

/** `parked`: the run waits on the person's answer and nothing more is done now. `fixesSince` belongs to the held-fix check. */
export type StageResult = { outcome: Outcome['outcome']; fixed: boolean; fixesSince: string | null }

/** The id of the "Fix it" choice in the question about a finding. */
export const FIX = 'fix'

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
  const none = (outcome: Outcome['outcome'], fixed = false): StageResult => ({ outcome, fixed, fixesSince: null })

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
  // A finding the cite check refuted stays as that and goes no further. The rest are looked at, most severe first.
  const alive = bySeverity(rows.filter(r => r.state === 'reported'))
  const checked = alive.slice(0, MAX_FINDINGS)
  const resolve = (row: FindingRow, end: End) => step.run(id(`resolve-${row.id}`), () => resolveFinding(ctx, opened.nodeId, row, end))
  // Beyond the limit they are not checked, and are not dismissed either: they wait for the person.
  for (const row of alive.slice(MAX_FINDINGS)) await resolve(row, { state: 'discarded', outcome: 'discarded', reason: strings.findings.tooMany })

  const core = checked.length > 0 ? await step.run(id(`review-core-${block.id}`), () => corePaths(checked[0]!.projectId)) : []
  let fixed = false
  for (const [i, row] of checked.entries()) {
    const verified = await step.run(id(`verify-${row.id}`), () => verifyFinding(ctx, opened.nodeId, row, i + 1, checked.length))
    if (verified.verdict === 'cancelled') return none('cancelled', fixed)
    let end: End | null = null
    let fixAs: 'asked_yes' | 'unchecked' | null = null
    if (verified.verdict === 'refuted') {
      end = { state: 'refuted', outcome: 'discarded', reason: verified.reason ?? strings.findings.notReproduced }
    } else if (verified.verdict === 'unbacked' && row.severity !== 'high') {
      end = { state: 'discarded', outcome: 'discarded', reason: strings.findings.notReproduced }
    } else {
      // Not shown to be real (unbacked, and high), or real in a place that matters: the person decides.
      const risk = riskOf(row, { corePaths: core, unknown: verified.verdict === 'unbacked' })
      if (verified.verdict === 'confirmed' && risk.level === 'low') {
        fixAs = 'unchecked'
      } else {
        const answer = await askAndWait(ctx, opened.nodeId, row, risk.reasons, verified.verdict === 'unbacked')
        if (answer === 'cancelled') return none('cancelled', fixed)
        if (answer === 'parked') return none('parked', fixed)
        const words = answer.answerText?.trim() ?? ''
        if (answer.answerOption === FIX) fixAs = 'asked_yes'
        else if (answer.answerOption === LEAVE) end = { state: 'discarded', outcome: 'asked_no', reason: words || strings.findings.leftByChoice }
        // The person's own words: the app cannot act on them by itself, so the problem stays in front of them.
        else end = { state: 'open', outcome: 'open', reason: words || strings.findings.fixFailed }
      }
    }
    if (fixAs) {
      const fix = await step.run(id(`fix-${row.id}`), () => fixFinding(ctx, opened.nodeId, row, verified.repro))
      if (fix.ran) fixed = true
      if (fix.status === 'cancelled') return none('cancelled', fixed)
      end = fix.status === 'fixed' ? { state: 'fixed_unchecked', outcome: fixAs, reason: strings.findings.fixedUnchecked } : { state: 'open', outcome: 'open', reason: strings.findings.fixFailed }
    }
    await resolve(row, end!)
  }

  const summary = alive.length > 0 ? strings.review.problems(alive.length) : rows.length > 0 ? strings.review.noProblemsLeft : strings.review.noProblems
  const outcome = await step.run(id(`review-close-${block.id}`), () => closeReview(runId, opened.nodeId, summary))
  return none(outcome, fixed)
}

type End = { state: FindingRow['state']; outcome: 'done' | 'asked_yes' | 'asked_no' | 'discarded' | 'unchecked' | 'open'; reason: string }
type Verified = { verdict: 'confirmed' | 'unbacked' | 'refuted' | 'cancelled'; reason?: string; repro?: Repro }

const asFinding = (r: FindingRow) => ({ type: r.type, ...(r.file !== undefined ? { file: r.file } : {}), ...(r.line !== undefined ? { line: r.line } : {}), problem: r.problem })

/** Runs `fn` with a signal that aborts when the run is cancelled. */
async function whileRunLasts<T>(runId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController()
  const timer = setInterval(async () => {
    if (await isCancelled(runId)) stop.abort()
  }, 500)
  try {
    return await fn(stop.signal)
  } finally {
    clearInterval(timer)
  }
}

const currentOf = async (runId: string, id: string) => (await findingsOf(runId)).find(f => f.id === id)

/** A line on the Review card while the node is running. */
async function sayOnCard(ctx: Context, nodeId: string, text: string): Promise<void> {
  await withTx(ctx.runId, async tx => {
    const node = await freshNode(nodeId, tx)
    if (node.state === 'running') await appendEventSync({ runId: ctx.runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: ctx.block.id, text: clip(redact(text), 240) } }, tx)
  })
}

/**
 * Tries to make one problem happen: a verifier writes a script in a throwaway copy (made and removed here, never
 * handed on), then the app runs that script itself in a fresh copy of the task's folder. Only what the app saw counts.
 */
async function verifyFinding(ctx: Context, nodeId: string, row: FindingRow, n: number, of: number): Promise<Verified> {
  const { runId, plan, block, deps, workspace } = ctx
  // A step that ran before: what it decided is on the row.
  const before = await currentOf(runId, row.id)
  if (before && before.state !== 'reported') {
    return before.state === 'confirmed' ? { verdict: 'confirmed', ...(before.repro ? { repro: before.repro } : {}) } : before.state === 'refuted' ? { verdict: 'refuted', ...(before.reason ? { reason: before.reason } : {}) } : { verdict: 'unbacked' }
  }
  if (await isCancelled(runId)) return { verdict: 'cancelled' }
  await sayOnCard(ctx, nodeId, strings.review.checking(n, of))
  const unbacked = async (reason: string, extra: { repro?: Repro; evidence?: Parameters<typeof setFinding>[1]['evidence'] } = {}): Promise<Verified> => {
    await setFinding(row.id, { state: 'unbacked', reason, ...extra })
    return { verdict: 'unbacked' }
  }
  const taskDir = workspace.workdir
  if (!taskDir) return unbacked(strings.findings.checkNotRun)
  let copy: string
  try {
    copy = await (deps.makeCopy ?? realMakeCopy)(taskDir)
  } catch {
    return unbacked(strings.findings.checkNotRun)
  }
  let result: AttemptResult
  try {
    result = await runAttempt(deps.resolveProvider(plan.providerId), block, plan.request, runId, { ...workspace, workdir: copy }, null, [], () => {}, () => {}, { role: 'verifier', finding: asFinding(row) })
  } finally {
    removeCopy(copy)
  }
  if (result.kind === 'cancelled') return { verdict: 'cancelled' }
  if (result.kind !== 'done') return unbacked(strings.findings.checkNotRun)
  if (result.refuted) {
    await setFinding(row.id, { state: 'refuted', reason: result.refuted.why })
    return { verdict: 'refuted', reason: result.refuted.why }
  }
  if (!result.repro) return unbacked(strings.findings.notReproduced)
  const repro = result.repro
  const evidence = await whileRunLasts(runId, signal => (deps.runRepro ?? realRunRepro)(repro, taskDir, signal))
  if (await isCancelled(runId)) return { verdict: 'cancelled' }
  if (!reproduced(evidence)) return unbacked(strings.findings.notReproduced, { repro, evidence })
  await setFinding(row.id, { state: 'confirmed', repro, evidence })
  return { verdict: 'confirmed', repro }
}

/** One fixer call in the task's working copy. Checking the fix is not done here. */
async function fixFinding(ctx: Context, nodeId: string, row: FindingRow, repro?: Repro): Promise<{ status: 'fixed' | 'failed' | 'cancelled'; ran: boolean }> {
  const { runId, plan, block, deps, workspace } = ctx
  if ((await currentOf(runId, row.id))?.state === 'fixed_unchecked') return { status: 'fixed', ran: true }
  if (await isCancelled(runId)) return { status: 'cancelled', ran: false }
  await sayOnCard(ctx, nodeId, strings.review.fixing)
  // It works like the builder, with the builder's model and time.
  const builder = plan.blocks.find(b => b.kind === 'build' && b.enabled) ?? block
  const result = await runAttempt(deps.resolveProvider(plan.providerId), builder, plan.request, runId, workspace, null, [], () => {}, () => {}, { role: 'fixer', finding: asFinding(row), ...(repro ? { repro } : {}) })
  if (result.kind === 'cancelled') return { status: 'cancelled', ran: true }
  if (result.kind !== 'done') return { status: 'failed', ran: true }
  await setFinding(row.id, { state: 'fixed_unchecked' })
  return { status: 'fixed', ran: true }
}

/** Asks (its own step), then waits for the answer the way the human block waits for a decision. */
async function askAndWait(ctx: Context, nodeId: string, row: FindingRow, reasons: string[], notChecked: boolean): Promise<Question | 'parked' | 'cancelled'> {
  const { runId, step, id } = ctx
  const asked = await step.run(id(`ask-${row.id}`), async (): Promise<Question | null> => {
    if (await isCancelled(runId)) return null
    const q = strings.question.forFinding(row, reasons, notChecked)
    const question = await askPerson(runId, nodeId, { findingId: row.id, kind: 'finding', text: q.text, why: q.why, options: q.options, recommended: FIX, touches: row.decisions })
    await setFinding(row.id, { state: 'asked' })
    return question
  })
  if (asked === null) return 'cancelled'
  let answer: Question | null = asked.state === 'answered' ? await step.run(id(`read-answer-${row.id}-first`), () => takeAnswer(asked.id)) : null
  // The event only says "look": the answer is read from its row. One that is not there yet is ignored and the wait goes on.
  for (let attempt = 0; attempt < MAX_IGNORED_DECISIONS && answer === null; attempt++) {
    const arrived = await step.waitForEvent(id(`question-${row.id}-${attempt}`), { event: QUESTION_ANSWERED, timeout: APPROVAL_WAIT, match: 'data.runId' })
    // No answer (the wait expired) leaves the run waiting on the person; nothing is decided for them.
    if (!arrived) return 'parked'
    answer = await step.run(id(`read-answer-${row.id}-${attempt}`), () => takeAnswer(asked.id))
  }
  return answer ?? 'parked'
}

/** Every ending: one register line, its number on the finding, and the event, together; a retry finds the number and does nothing. */
async function resolveFinding(ctx: Context, nodeId: string, row: FindingRow, end: End): Promise<void> {
  const { runId, block } = ctx
  await withTx(runId, async tx => {
    const current = (await tx.select().from(findings).where(eq(findings.id, row.id)))[0]
    if (!current || current.entryNumber !== null) return
    const entry = await addEntry(
      row.projectId,
      { kind: 'finding', text: clip(redact(row.problem), 300), ...(row.file ? { paths: [row.file] } : {}), source: 'review', runId, outcome: end.outcome, reason: clip(redact(end.reason), 500) },
      tx,
    )
    await setFinding(row.id, { state: end.state, reason: end.reason, ...(entry ? { entryNumber: entry.number } : {}) }, tx)
    await appendEventSync({ runId, nodeRunId: nodeId, type: 'node.finding_resolved', payload: { blockId: block.id, findingId: row.id, state: end.state, outcome: end.outcome } }, tx)
  })
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

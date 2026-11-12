import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { findings, nodeRuns, runs } from '@/db/schema'
import { canTransition, type NodeState } from '@/domain/states'
import { appendEventSync } from '@/engine/events'
import { bySeverity, findingsOf, mergeDuplicates, recordFindings, riskOf, setFinding, type FindingRow } from '@/engine/findings'
import { QUESTION_ANSWERED } from '@/engine/inngest/client'
import { LEAVE, askPerson, takeAnswer, type Question } from '@/engine/questions'
import { addEntry, corePaths, standingFor, touchesCore } from '@/engine/register'
import { corrected, makeCopy as realMakeCopy, removeCopy, reproduced, runRepro as realRunRepro, type Repro, type ReproRun } from '@/engine/repro'
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
import { MAX_FINDINGS, focusesFor, whereOf, type Finding, type Focus, type Review } from '@/engine/review'
import { clip, redact } from '@/engine/redact'
import { SENSITIVE, assessRisk } from '@/engine/risk'
import { MAX_FIX_ATTEMPTS, changedBetween, changedSince, restoreTree, snapshotTree } from '@/engine/tree-snapshot'
import { strings } from '@/ui/strings'

// The Review block, for a provider that works on files: one reader on a small change, three on anything else, each
// looking for one thing. What they report is only a claim; it is checked against the code (findings.ts) before the
// builder is told any of it. One node on the card holds all of it; each reader is a step of its own, so a retry
// never reads twice, and the findings are recorded in a step of their own, once per round.
//
// Every finding that held up is then verified by reproducing it in a throwaway copy, and routed: fixed when it is small
// and safe, put to the person when it touches what matters, dropped when it cannot be shown. Every side effect is a step
// of its own (verify, ask, resolve, fix, each with the finding's id) and writes only if the finding is not already there.

/**
 * `parked`: the run waits on the person's answer and nothing more is done now. `fixed`: at least one fix was kept.
 * `fixesSince`: the tree as it was before the first kept fix (null when none was kept).
 */
export type StageResult = { outcome: Outcome['outcome']; fixed: boolean; fixesSince: string | null }

/** The id of the "Fix it" choice in the question about a finding. */
export const FIX = 'fix'
/** The ids of the choices in the question about a fix that strayed. Everything but KEEP takes the fix back. */
export const KEEP = 'keep'
export const UNDO = 'undo'

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
  let fixesSince: string | null = null
  const none = (outcome: Outcome['outcome'], fixed = false): StageResult => ({ outcome, fixed, fixesSince })

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
  // Beyond the limit they are not checked, and are not dismissed either: they stay open for the person.
  for (const row of alive.slice(MAX_FINDINGS)) await resolve(row, { state: 'open', outcome: 'open', reason: strings.findings.tooMany })

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
        const answer = await askAndWait(ctx, opened.nodeId, row, '', () => askAboutFinding(ctx, opened.nodeId, row, risk.reasons, verified.verdict === 'unbacked'))
        if (answer === 'cancelled') return none('cancelled', fixed)
        if (answer === 'parked') return none('parked', fixed)
        const words = answer.answerText?.trim() ?? ''
        if (answer.answerOption === FIX) fixAs = 'asked_yes'
        else if (answer.answerOption === LEAVE) end = { state: 'discarded', outcome: 'asked_no', reason: words || strings.findings.leftByChoice }
        // The person's own words: the app cannot act on them by itself, so the problem stays in front of them.
        else end = { state: 'open', outcome: 'open', reason: words || strings.findings.unclearAnswer }
      }
    }
    if (fixAs) {
      const made = await fixOne(ctx, opened.nodeId, row, verified.repro, fixAs, core)
      if (made === 'cancelled') return none('cancelled', fixed)
      if (made === 'parked') return none('parked', fixed)
      end = made.end
      if (made.kept) {
        fixed = true
        fixesSince ??= made.kept
      }
    }
    await resolve(row, end!)
  }

  const summary = alive.length > 0 ? strings.review.problems(alive.length) : rows.length > 0 ? strings.review.noProblemsLeft : strings.review.noProblems
  const outcome = await step.run(id(`review-close-${block.id}`), () => closeReview(runId, opened.nodeId, summary))
  return none(outcome, fixed)
}

type End = { state: FindingRow['state']; outcome: 'done' | 'asked_yes' | 'asked_no' | 'discarded' | 'unchecked' | 'open'; reason: string; evidence?: ReproRun }
type Verified = { verdict: 'confirmed' | 'unbacked' | 'refuted' | 'cancelled'; reason?: string; repro?: Repro }

const asFinding = (r: FindingRow) => ({ type: r.type, ...(r.file !== undefined ? { file: r.file } : {}), ...(r.line !== undefined ? { line: r.line } : {}), problem: r.problem })

/** Runs `fn` with a signal that aborts when the run is cancelled. */
async function whileRunLasts<T>(runId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController()
  const timer = setInterval(async () => {
    try {
      if (await isCancelled(runId)) stop.abort()
    } catch {
      // not read this time; the next tick tries again
    }
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

/**
 * One fix, made on its own: the tree is saved, then up to MAX_FIX_ATTEMPTS times the fixer works and the app re-runs the
 * reproduction itself. A fix that strayed into something that matters is put to the person first. A fix that does not
 * solve it is taken back. Every side effect is a step of its own, with ids unique to the finding and the attempt.
 */
async function fixOne(
  ctx: Context,
  nodeId: string,
  row: FindingRow,
  repro: Repro | undefined,
  fixAs: 'asked_yes' | 'unchecked',
  core: string[],
): Promise<{ end: End; kept: string | null } | 'cancelled' | 'parked'> {
  const { step, id, workspace } = ctx
  const workdir = workspace.workdir
  const open = (reason: string): { end: End; kept: null } => ({ end: { state: 'open', outcome: 'open', reason }, kept: null })
  // Taken once, before the first attempt; every later step and every replay reads the same id.
  const snap = await step.run(id(`snap-${row.id}`), () => takeSnapshot(workdir))
  if (snap === null || !workdir) return open(strings.findings.fixNotStarted)
  // What the task had already changed before the fix: a fix in such a place is not a new stray.
  const already = new Set(await step.run(id(`before-${row.id}`), () => changedBefore(workdir, workspace.baseCommit, snap)))
  const takeBack = (name: string) => step.run(id(`${name}-${row.id}`), () => restoreTree(workdir, snap))
  // The person was asked about this one at some point: the register line says so.
  let asked = fixAs === 'asked_yes'
  let heldAsked = false

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    const made = await step.run(id(`fix-${row.id}-${attempt}`), () => fixFinding(ctx, nodeId, row, workdir, snap, repro))
    if (made.status === 'cancelled') return 'cancelled'
    if (made.status === 'failed') {
      await takeBack('rollback')
      return open(strings.findings.fixFailed)
    }
    const strayed = fixAs === 'unchecked' && !heldAsked ? strayedInto(made.paths, core, already) : null
    if (strayed) {
      heldAsked = true
      const answer = await askAndWait(ctx, nodeId, row, 'held-', () => askAboutHeldFix(ctx, nodeId, row, strayed))
      if (answer === 'cancelled') return 'cancelled'
      if (answer === 'parked') return 'parked'
      // Only "Keep the fix" keeps it. Undoing is the safe default, so leaving the question or answering in the person's own words undoes it too.
      if (answer.answerOption !== KEEP) {
        await takeBack('undo')
        return { end: { state: 'discarded', outcome: 'asked_no', reason: answer.answerText?.trim() || strings.findings.fixUndone }, kept: null }
      }
      asked = true
    }
    // Nothing to run for a problem that could not be shown: the fix stands, unchecked.
    if (!repro) return { end: { state: 'fixed_unchecked', outcome: asked ? 'asked_yes' : 'unchecked', reason: strings.findings.fixedUnchecked }, kept: snap }
    const evidence = await step.run(id(`check-${row.id}-${attempt}`), () => checkFix(ctx, workdir, repro))
    if (evidence === null) return 'cancelled'
    if (corrected(evidence)) return { end: { state: 'corrected', outcome: asked ? 'asked_yes' : 'done', reason: strings.findings.fixedChecked, evidence }, kept: snap }
  }
  // A fix that does not work is not left in the person's change.
  await takeBack('rollback')
  return open(strings.findings.fixNotSolved)
}

async function takeSnapshot(workdir: string | null | undefined): Promise<string | null> {
  if (!workdir) return null
  try {
    return snapshotTree(workdir)
  } catch {
    return null
  }
}

/** The paths the task had changed, against its base commit, when the snapshot was taken. Unknown counts as none, which asks more rather than less. */
async function changedBefore(workdir: string, baseCommit: string | null | undefined, snap: string): Promise<string[]> {
  if (!baseCommit) return []
  try {
    return changedBetween(workdir, baseCommit, snap)
  } catch {
    return []
  }
}

/** The changed paths that are in a core area or a sensitive kind of file and were not already changed by the task. */
function strayedInto(paths: string[], core: string[], already: ReadonlySet<string>): { paths: string[]; core: boolean; areas: string[] } | null {
  const hit = paths.filter(p => !already.has(p) && (touchesCore(p, core) || SENSITIVE.some(([re]) => re.test(p))))
  if (hit.length === 0) return null
  const areas = [...new Set(hit.flatMap(p => SENSITIVE.filter(([re]) => re.test(p)).map(([, label]) => label)))]
  return { paths: hit, core: hit.some(p => touchesCore(p, core)), areas }
}

/** One fixer call in the task's working copy, starting from the saved tree. Checking the fix is not done here. */
async function fixFinding(ctx: Context, nodeId: string, row: FindingRow, workdir: string, snap: string, repro?: Repro): Promise<{ status: 'fixed' | 'failed' | 'cancelled'; paths: string[] }> {
  const { runId, plan, block, deps, workspace } = ctx
  // A finding that is already resolved was fixed by an earlier run of this step: nothing is called again.
  if ((await currentOf(runId, row.id))?.entryNumber != null) return { status: 'fixed', paths: [] }
  if (await isCancelled(runId)) return { status: 'cancelled', paths: [] }
  // A fixer that ran before but whose result was not recorded, or an attempt that did not work, must not be built on.
  if (changedSince(workdir, snap).length > 0) restoreTree(workdir, snap)
  await sayOnCard(ctx, nodeId, strings.review.fixing)
  // It works like the builder, with the builder's model and time.
  const builder = plan.blocks.find(b => b.kind === 'build' && b.enabled) ?? block
  const result = await runAttempt(deps.resolveProvider(plan.providerId), builder, plan.request, runId, workspace, null, [], () => {}, () => {}, { role: 'fixer', finding: asFinding(row), ...(repro ? { repro } : {}) })
  if (result.kind === 'cancelled') return { status: 'cancelled', paths: [] }
  if (result.kind !== 'done') return { status: 'failed', paths: [] }
  return { status: 'fixed', paths: changedSince(workdir, snap) }
}

/** The app runs the reproduction itself on the task's folder; only what it saw counts. Null when the run was cancelled. */
async function checkFix(ctx: Context, workdir: string, repro: Repro): Promise<ReproRun | null> {
  const { runId, deps } = ctx
  if (await isCancelled(runId)) return null
  const evidence = await whileRunLasts(runId, signal => (deps.runRepro ?? realRunRepro)(repro, workdir, signal))
  return (await isCancelled(runId)) ? null : evidence
}

/** The question about a fix that changed something that matters. */
async function askAboutHeldFix(ctx: Context, nodeId: string, row: FindingRow, strayed: { paths: string[]; core: boolean; areas: string[] }): Promise<Question> {
  const q = strings.question.forHeldFix({ core: strayed.core, areas: strayed.areas })
  const said = `${whereOf(row) ? `${whereOf(row)}: ` : ''}${row.problem}`
  const entries = (await standingFor(row.projectId)).filter(e => e.kind === 'core' && strayed.paths.some(p => touchesCore(p, e.paths)))
  return askPerson(ctx.runId, nodeId, {
    findingId: row.id,
    kind: 'fix_held',
    text: q.text,
    why: q.why,
    detail: clip(redact(strings.question.heldDetail(strayed.paths, said)), 600),
    options: q.options,
    recommended: UNDO,
    touches: entries.map(e => e.number),
  })
}

/** The question about a problem the app will not decide alone. The app's own sentence is the question; what the AI reviewer said travels beside it, redacted, for one click away. */
function askAboutFinding(ctx: Context, nodeId: string, row: FindingRow, reasons: string[], notChecked: boolean): Promise<Question> {
  const q = strings.question.forFinding(row, reasons, notChecked)
  const detail = `${whereOf(row) ? `${whereOf(row)}: ` : ''}${row.problem}`
  return askPerson(ctx.runId, nodeId, { findingId: row.id, kind: 'finding', text: q.text, why: q.why, detail: clip(redact(detail), 600), options: q.options, recommended: FIX, touches: row.decisions })
}

/** Asks (its own step), then waits for the answer the way the human block waits for a decision. `tag` keeps the step ids of one kind of question apart. */
async function askAndWait(ctx: Context, nodeId: string, row: FindingRow, tag: '' | 'held-', ask: () => Promise<Question>): Promise<Question | 'parked' | 'cancelled'> {
  const { runId, step, id } = ctx
  const asked = await step.run(id(`ask-${tag}${row.id}`), async (): Promise<Question | null> => {
    if (await isCancelled(runId)) return null
    const question = await ask()
    // A step that runs again after the answer came in must not take the finding back to "asked".
    if (question.state === 'open') await setFinding(row.id, { state: 'asked' })
    return question
  })
  if (asked === null) return 'cancelled'
  let answer: Question | null = asked.state === 'answered' ? await step.run(id(`read-answer-${tag}${row.id}-first`), () => takeAnswer(asked.id)) : null
  // The event only says "look": the answer is read from its row. One that is not there yet is ignored and the wait goes on.
  for (let attempt = 0; attempt < MAX_IGNORED_DECISIONS && answer === null; attempt++) {
    const arrived = await step.waitForEvent(id(`question-${tag}${row.id}-${attempt}`), { event: QUESTION_ANSWERED, timeout: APPROVAL_WAIT, match: 'data.runId' })
    // No answer (the wait expired) leaves the run waiting on the person; nothing is decided for them.
    if (!arrived) return 'parked'
    const read = await step.run(id(`read-answer-${tag}${row.id}-${attempt}`), async () => ((await isCancelled(runId)) ? ('cancelled' as const) : takeAnswer(asked.id)))
    if (read === 'cancelled') return 'cancelled'
    answer = read
  }
  return answer ?? 'parked'
}

/** Every ending: one register line, its number on the finding, and the event, together; a retry finds the number and does nothing. */
async function resolveFinding(ctx: Context, nodeId: string, row: FindingRow, end: End): Promise<void> {
  const { runId, block } = ctx
  await withTx(runId, async tx => {
    // A run that was cancelled while this was waiting to start records nothing more.
    const status = (await tx.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)))[0]?.s
    if (status === 'cancelled') return
    const current = (await tx.select().from(findings).where(eq(findings.id, row.id)))[0]
    if (!current || current.entryNumber !== null) return
    const entry = await addEntry(
      row.projectId,
      { kind: 'finding', text: clip(redact(row.problem), 300), ...(row.file ? { paths: [row.file] } : {}), source: 'review', runId, outcome: end.outcome, reason: clip(redact(end.reason), 500) },
      tx,
    )
    await setFinding(row.id, { state: end.state, reason: end.reason, ...(end.evidence ? { evidence: end.evidence } : {}), ...(entry ? { entryNumber: entry.number } : {}) }, tx)
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

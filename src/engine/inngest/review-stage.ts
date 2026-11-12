import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { findings, nodeRuns, runs } from '@/db/schema'
import { canTransition, type NodeState } from '@/domain/states'
import { appendEventSync } from '@/engine/events'
import { bySeverity, citedPath, findingsOf, mergeDuplicates, recordFindings, riskOf, setFinding, type FindingRow } from '@/engine/findings'
import { QUESTION_ANSWERED } from '@/engine/inngest/client'
import { LEAVE, askPerson, consumeAnswer, type Question } from '@/engine/questions'
import { addEntry, corePaths, standingFor, touchesCore } from '@/engine/register'
import { corrected, makeCopy as realMakeCopy, removeCopy, reproduced, runRepro as realRunRepro, type NoRepro, type Repro, type ReproRun } from '@/engine/repro'
import {
  APPROVAL_WAIT,
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
import { SENSITIVE, assessRisk, classifyChange, type ChangedFile } from '@/engine/risk'
import { MAX_FIX_ATTEMPTS, changedBetween, changedPaths, looseChanges, measureSince, releaseAttempts, restoreTree, startAttempt, takeSnap, undoChange, type Options as SnapOptions, type Snap } from '@/engine/tree-snapshot'
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
  /** A second look after fixes: the tree as it was before the first fix. What changed since is measured once, at the start of the round. */
  reviewSince: string | null
}

type Reading = { review: Review | null; unreadable?: true } | { outcome: 'cancelled' | 'failed' | 'passed' | 'skipped' | 'parked' } | { failed: ReturnType<typeof describeFailure> & { messageSource: 'provider' | 'system'; attempt: number } }

const SUMMARY_MAX = 600

export async function runReviewStage(ctx: Context): Promise<StageResult> {
  const { runId, block, step, id, workspace } = ctx
  let fixesSince: string | null = null
  const none = (outcome: Outcome['outcome'], fixed = false): StageResult => ({ outcome, fixed, fixesSince })

  // After fixes: what they changed, found once for the round (null when it cannot be read: the whole change is read then).
  const since = ctx.reviewSince ? await step.run(id(`review-since-${block.id}`), () => sinceOf(ctx.reviewSince!, workspace, ctx.deps)) : null
  const sinceForReaders = since ? { paths: since.paths, diff: since.diff, ...(since.more > 0 ? { more: since.more } : {}) } : null
  // How deep to read is measured once for the round, from the change as it stands: after fixes, from what the fixes changed.
  const risk = await step.run(id(`review-depth-${block.id}`), () => depthOf(runId, workspace, since ?? undefined))
  const focuses = focusesFor(risk)
  const opened = await step.run(id(`review-open-${block.id}`), async () => {
    const node = await openProviderNode(runId, block, [focuses.length === 1 ? strings.review.depth.one : strings.review.depth.three])
    return 'outcome' in node ? node : { nodeId: node.id }
  })
  if ('outcome' in opened) return none(opened.outcome)
  // A second look that could not be narrowed says so once.
  if (ctx.reviewSince && !since) await step.run(id(`review-since-said-${block.id}`), () => sayOnCard(ctx, opened.nodeId, strings.review.sinceUnreadable))

  const found: { focus: Focus; finding: Finding }[] = []
  // Readers that answered without a verdict: never counted as having found nothing.
  let unreadable = 0
  for (const focus of focuses) {
    const reading = await step.run(id(`review-${block.id}-${focus}`), () => readFor(ctx, opened.nodeId, focus, sinceForReaders))
    if ('outcome' in reading) return none(reading.outcome)
    if ('failed' in reading) {
      // A reader that failed, or changed a file, makes the block fail; nothing any reader said is used.
      const outcome = await step.run(id(`review-fail-${block.id}`), () => failReview(runId, opened.nodeId, reading.failed))
      return none(outcome)
    }
    if (reading.unreadable) unreadable++
    // One problem cited two ways ("./a.ts", the full path) is one problem: paths are read as the project names them first.
    for (const finding of reading.review?.findings ?? []) found.push({ focus, finding: finding.file !== undefined && workspace.workdir ? { ...finding, file: citedPath(workspace.workdir, finding.file) } : finding })
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
  // Those left open are for the person, so they are real as far as the card is concerned.
  let real = alive.length - checked.length

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
    // A report the checker refuted, or could not make happen, was not a problem; anything else (fixed, left by choice, still open) was.
    if (!((end!.state === 'refuted' || end!.state === 'discarded') && end!.outcome === 'discarded')) real++
    if (fixAs && workspace.workdir) releaseAttempts(workspace.workdir, row.id, ctx.deps.snapshotStore ? { store: ctx.deps.snapshotStore } : {})
  }

  // "Found no problems" is said only when every reader gave a verdict; a missing part of the review is always said.
  const what = real > 0 ? strings.review.found(real, focuses.length) : rows.length > 0 ? strings.review.noneWasReal(rows.length) : unreadable === 0 ? strings.review.noneFound(focuses.length) : null
  const summary = [what, unreadable > 0 ? strings.review.someUnreadable(unreadable) : null].filter((s): s is string => s !== null).join(' ')
  const outcome = await step.run(id(`review-close-${block.id}`), () => closeReview(runId, opened.nodeId, summary, unreadable))
  return none(outcome, fixed)
}

type End = { state: FindingRow['state']; outcome: 'done' | 'asked_yes' | 'asked_no' | 'discarded' | 'unchecked' | 'open'; reason: string; evidence?: ReproRun }
/** Why a check ended without proof: what the verifier's answer lacked (NoRepro), or where the stage itself stopped. */
type UnbackedWhy = NoRepro | 'no_folder' | 'copy_failed' | `verifier_${Exclude<AttemptResult['kind'], 'done' | 'cancelled'>}` | 'no_repro' | 'app_run_not_reproduced'
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
  // `why` is for a developer reading the run later: the person sees `reason` only.
  const unbacked = async (reason: string, why: UnbackedWhy, extra: { repro?: Repro; evidence?: ReproRun; answer?: string } = {}): Promise<Verified> => {
    const { answer, ...kept } = extra
    await withTx(runId, async tx => {
      await setFinding(row.id, { state: 'unbacked', reason, ...kept }, tx)
      const measured = kept.evidence ? { exitCode: kept.evidence.exitCode, markerSeen: kept.evidence.markerSeen } : {}
      await appendEventSync({ runId, nodeRunId: nodeId, type: 'node.finding_checked', payload: { blockId: block.id, findingId: row.id, verdict: 'unbacked', why, ...measured, ...(answer !== undefined ? { answer } : {}) } }, tx)
    })
    return { verdict: 'unbacked' }
  }
  const taskDir = workspace.workdir
  if (!taskDir) return unbacked(strings.findings.checkNotRun, 'no_folder')
  let copy: string
  try {
    copy = await (deps.makeCopy ?? realMakeCopy)(taskDir)
  } catch {
    return unbacked(strings.findings.checkNotRun, 'copy_failed')
  }
  let result: AttemptResult
  try {
    result = await runAttempt(deps.resolveProvider(plan.providerId), block, plan.request, runId, { ...workspace, workdir: copy }, null, [], () => {}, () => {}, { role: 'verifier', finding: asFinding(row) })
  } finally {
    removeCopy(copy)
  }
  if (result.kind === 'cancelled') return { verdict: 'cancelled' }
  if (result.kind !== 'done') return unbacked(strings.findings.checkNotRun, `verifier_${result.kind}`)
  if (result.refuted) {
    await setFinding(row.id, { state: 'refuted', reason: result.refuted.why })
    return { verdict: 'refuted', reason: result.refuted.why }
  }
  if (!result.repro) return unbacked(strings.findings.notReproduced, result.noRepro?.why ?? 'no_repro', result.noRepro ? { answer: result.noRepro.answer } : {})
  const repro = result.repro
  const evidence = await whileRunLasts(runId, signal => (deps.runRepro ?? realRunRepro)(repro, taskDir, signal))
  if (await isCancelled(runId)) return { verdict: 'cancelled' }
  if (!reproduced(evidence)) return unbacked(strings.findings.notReproduced, 'app_run_not_reproduced', { repro, evidence })
  await setFinding(row.id, { state: 'confirmed', repro, evidence })
  return { verdict: 'confirmed', repro }
}

/** The paths that strayed: at most MAX_CARRIED_PATHS of them, with `more` for the rest. */
type Stray = { paths: string[]; more: number; core: boolean; areas: string[] }
/** What one fixer attempt did. `paths` is cut to MAX_CARRIED_PATHS (with `count` the full number); `strays` is kept in full. */
/** `start`: the folder as this attempt began (null when it could not be known). Every undo and measure of the attempt is against it. */
type Made = { status: 'fixed' | 'failed' | 'cancelled'; count: number; paths: string[]; strays: Stray | null; start: Snap | null; after: Snap | null }
type TakenBack = { kept: string[]; failed: string[]; error: boolean }
const MAX_CARRIED_PATHS = 200

/**
 * One fix, made on its own: the tree is saved, then up to MAX_FIX_ATTEMPTS times the fixer works and the app re-runs the
 * reproduction itself. A fix that strayed into something that matters is put to the person first. A fix that does not
 * solve it is taken back, but only what the fix changed: whatever the person changed meanwhile stays. Every side effect
 * is a step of its own, with ids unique to the finding and the attempt.
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
  const opts: SnapOptions = ctx.deps.snapshotStore ? { store: ctx.deps.snapshotStore } : {}
  const open = (reason: string): { end: End; kept: null } => ({ end: { state: 'open', outcome: 'open', reason }, kept: null })
  // Taken once, before the first attempt; every later step and every replay reads the same id.
  const snap = await step.run(id(`snap-${row.id}`), () => takeSnapshot(workdir, opts))
  if (snap === null || !workdir) return open(strings.findings.fixNotStarted)
  // What the task had already changed before the fix: a fix in such a place is not a new stray.
  const already = new Set(await step.run(id(`before-${row.id}`), () => changedBefore(workdir, workspace.baseCommit, snap.tree, opts)))
  const takeBack = (name: string, made: Made) => step.run(id(`${name}-${row.id}`), (): TakenBack => (made.start ? giveBack(workdir, made.start, made.after, opts) : { kept: [], failed: [], error: false }))
  // A fix that could not be taken back completely ends the finding open, saying so.
  const stuck = (back: TakenBack) => open(strings.findings.fixNotTakenBack(back.failed))
  // The person was asked about this one at some point: the register line says so.
  let asked = fixAs === 'asked_yes'
  // The paths the person agreed to on the held question; a later attempt may not go beyond them.
  let approved: Stray | null = null

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    const made = await step.run(id(`fix-${row.id}-${attempt}`), () => fixFinding(ctx, nodeId, row, workdir, repro, attempt, core, already, opts))
    if (made.status === 'cancelled') return 'cancelled'
    if (made.status === 'failed') {
      // Where this attempt began is not known: nothing is restored, and the finding says the fix did not go through.
      if (made.start === null) return open(strings.findings.fixFailed)
      const back = await takeBack('rollback', made)
      return back.error || back.failed.length > 0 ? stuck(back) : open(strings.findings.fixFailed)
    }
    if (approved !== null) {
      if (made.strays && (made.strays.paths.some(p => !approved!.paths.includes(p)) || made.strays.more > approved.more)) {
        const back = await takeBack('rollback', made)
        return back.error || back.failed.length > 0 ? stuck(back) : open(strings.findings.strayedAgain)
      }
    } else if (fixAs === 'unchecked' && made.strays) {
      const strayed = made.strays
      const answer = await askAndWait(ctx, nodeId, row, 'held-', () => askAboutHeldFix(ctx, nodeId, row, strayed))
      if (answer === 'cancelled') return 'cancelled'
      if (answer === 'parked') return 'parked'
      if (answer.answerOption !== KEEP) {
        const back = await takeBack('undo', made)
        const words = answer.answerText?.trim()
        // Only "Undo it" is the person's decision about the problem; leaving the question or answering in their own words keeps it flagged for them.
        const end: End =
          answer.answerOption === UNDO
            ? { state: 'discarded', outcome: 'asked_no', reason: words || strings.findings.fixUndone }
            : { state: 'open', outcome: 'open', reason: words || strings.findings.fixUndoneOpen }
        if (back.error || back.failed.length > 0) return stuck(back)
        return { end: back.kept.length > 0 ? { ...end, reason: `${end.reason} ${strings.findings.leftAsTheyAre(back.kept)}` } : end, kept: null }
      }
      asked = true
      approved = strayed
    }
    // Nothing to run for a problem that could not be shown: the fix stands, unchecked.
    if (!repro) return { end: { state: 'fixed_unchecked', outcome: asked ? 'asked_yes' : 'unchecked', reason: strings.findings.fixedUnchecked }, kept: snap.tree }
    const evidence = await step.run(id(`check-${row.id}-${attempt}`), () => checkFix(ctx, workdir, repro))
    if (evidence === null) return 'cancelled'
    if (corrected(evidence)) return { end: { state: 'corrected', outcome: asked ? 'asked_yes' : 'done', reason: strings.findings.fixedChecked, evidence }, kept: snap.tree }
    // The next attempt starts from what the person had, not from what this one left.
    if (attempt < MAX_FIX_ATTEMPTS) {
      const back = await takeBack(`retire-${attempt}`, made)
      if (back.error || back.failed.length > 0) return stuck(back)
    } else {
      // A fix that does not work is not left in the person's change.
      const back = await takeBack('rollback', made)
      if (back.error || back.failed.length > 0) return stuck(back)
      return open(back.kept.length > 0 ? `${strings.findings.fixNotSolved} ${strings.findings.leftAsTheyAre(back.kept)}` : strings.findings.fixNotSolved)
    }
  }
  return open(strings.findings.fixNotSolved) // unreachable: the last attempt returns above
}

/** Takes back what a fix did, never throwing: a failure is reported so that the finding can say so. */
function giveBack(workdir: string, start: Snap, after: Snap | null, opts: SnapOptions): TakenBack {
  try {
    if (after) {
      const done = undoChange(workdir, start, after, opts)
      return { kept: done.kept, failed: done.failed, error: false }
    }
    // No record of what the fixer did (it ended without one): the folder goes back to where this attempt began.
    restoreTree(workdir, start.tree, opts)
    return { kept: [], failed: [], error: false }
  } catch {
    // Said by name where it can be found out without a new snapshot.
    let named: string[] = []
    try {
      named = looseChanges(workdir, start, opts)
    } catch {
      // nothing to name
    }
    return { kept: [], failed: named, error: true }
  }
}

function takeSnapshot(workdir: string | null | undefined, opts: SnapOptions): Snap | null {
  if (!workdir) return null
  try {
    return takeSnap(workdir, opts)
  } catch {
    return null
  }
}

/** The paths the task had changed, against its base commit, when the snapshot was taken. Unknown counts as none, which asks more rather than less. */
function changedBefore(workdir: string, baseCommit: string | null | undefined, tree: string, opts: SnapOptions): string[] {
  if (!baseCommit) return []
  try {
    return changedBetween(workdir, baseCommit, tree, opts)
  } catch {
    return []
  }
}

/** The changed paths that are in a core area or a sensitive kind of file and were not already changed by the task. */
function strayedInto(paths: string[], core: string[], already: ReadonlySet<string>): Stray | null {
  const hit = paths.filter(p => !already.has(p) && (touchesCore(p, core) || SENSITIVE.some(([re]) => re.test(p))))
  if (hit.length === 0) return null
  const areas = [...new Set(hit.flatMap(p => SENSITIVE.filter(([re]) => re.test(p)).map(([, label]) => label)))]
  return { paths: hit.slice(0, MAX_CARRIED_PATHS), more: Math.max(0, hit.length - MAX_CARRIED_PATHS), core: hit.some(p => touchesCore(p, core)), areas }
}

/**
 * One fixer call in the task's working copy. Never throws once the fixer has been called: whatever goes wrong afterwards
 * is a failed attempt, so that it is taken back. Checking the fix is not done here.
 */
async function fixFinding(
  ctx: Context,
  nodeId: string,
  row: FindingRow,
  workdir: string,
  repro: Repro | undefined,
  attempt: number,
  core: string[],
  already: ReadonlySet<string>,
  opts: SnapOptions,
): Promise<Made> {
  const { runId, plan, block, deps, workspace } = ctx
  let start: Snap | null = null
  const none = (status: Made['status'], after: Snap | null = null): Made => ({ status, count: 0, paths: [], strays: null, start, after })
  // A finding that is already resolved was fixed by an earlier run of this step: nothing is called again.
  if ((await currentOf(runId, row.id))?.entryNumber != null) return none('fixed')
  if (await isCancelled(runId)) return none('cancelled')
  try {
    // The folder as it is right now is remembered for this attempt. If this step runs again (the fixer ran but its result was
    // not recorded) a half-edit may be there with no record of it, and the folder goes back to that remembered state: never
    // further back, so what the person did before this attempt began stays. The window exists only while this attempt's fixer is running.
    const started = startAttempt(workdir, `${row.id}-${attempt}`, opts)
    start = started.start
    if (started.again && start) restoreTree(workdir, start.tree, opts)
  } catch {
    return none('failed')
  }
  // A marker that cannot be read: where the attempt began is unknown, so nothing is restored and the attempt has failed.
  if (!start) return none('failed')
  await sayOnCard(ctx, nodeId, strings.review.fixing)
  // It works like the builder, with the builder's model and time.
  const builder = plan.blocks.find(b => b.kind === 'build' && b.enabled) ?? block
  const result = await runAttempt(deps.resolveProvider(plan.providerId), builder, plan.request, runId, workspace, null, [], () => {}, () => {}, { role: 'fixer', finding: asFinding(row), ...(repro ? { repro } : {}) })
  if (result.kind === 'cancelled') return none('cancelled')
  try {
    const after = takeSnap(workdir, opts)
    if (result.kind !== 'done') return none('failed', after)
    const paths = changedPaths(workdir, start, after, opts)
    return { status: 'fixed', count: paths.length, paths: paths.slice(0, MAX_CARRIED_PATHS), strays: strayedInto(paths, core, already), start, after }
  } catch {
    return none('failed')
  }
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
  let answer: Question | null = asked.state === 'answered' ? await step.run(id(`read-answer-${tag}${row.id}-first`), () => consumeAnswer(asked.id)) : null
  // The event only says "look": the answer is read from its row, and reading it marks it taken (the relay tells the run again until then). One that is not there yet is ignored and the wait goes on.
  for (let attempt = 0; attempt < MAX_IGNORED_DECISIONS && answer === null; attempt++) {
    const arrived = await step.waitForEvent(id(`question-${tag}${row.id}-${attempt}`), { event: QUESTION_ANSWERED, timeout: APPROVAL_WAIT, match: 'data.runId' })
    // No answer (the wait expired) leaves the run waiting on the person; nothing is decided for them.
    if (!arrived) return 'parked'
    const read = await step.run(id(`read-answer-${tag}${row.id}-${attempt}`), async () => ((await isCancelled(runId)) ? ('cancelled' as const) : consumeAnswer(asked.id)))
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

/** The most of the change since the first review carried through a step: its diff in characters, and its paths and files in entries. */
const MAX_SINCE_DIFF_CARRIED = 100_000
const MAX_SINCE_PATHS_CARRIED = 200

/** `more`: how many changed files are beyond the carried list. */
type Since = { paths: string[]; diff: string; files: ChangedFile[]; more: number }

/** What changed since the tree before the first fix. Null when it cannot be read. */
async function sinceOf(tree: string, workspace: Workspace, deps: ExecutorDeps): Promise<Since | null> {
  if (!workspace.workdir) return null
  try {
    const m = measureSince(workspace.workdir, tree, deps.snapshotStore ? { store: deps.snapshotStore } : {})
    return {
      paths: m.paths.slice(0, MAX_SINCE_PATHS_CARRIED),
      diff: clip(redact(m.diff), MAX_SINCE_DIFF_CARRIED),
      files: m.files.slice(0, MAX_SINCE_PATHS_CARRIED),
      more: Math.max(0, m.paths.length - MAX_SINCE_PATHS_CARRIED),
    }
  } catch {
    return null
  }
}

async function depthOf(runId: string, workspace: Workspace, since?: Since): Promise<'low' | 'high'> {
  // A change that cannot be measured is read as carefully as a risky one.
  if (!workspace.workdir || !workspace.baseCommit) return 'high'
  const tests = await testFactsOf(runId)
  const projectId = (await db.select({ p: runs.projectId }).from(runs).where(eq(runs.id, runId)))[0]?.p
  const core = projectId ? await corePaths(projectId) : []
  // The same rules, on the files changed since the first review. More files than were carried is far past the limit already.
  if (since) return since.more > 0 ? 'high' : classifyChange(since.files, tests, core).level
  return assessRisk(workspace.workdir, workspace.baseCommit, tests, core).level
}

/** What the builder said it did, from the build node's stored sentence. */
async function builderSummaryOf(ctx: Context): Promise<string | undefined> {
  const build = ctx.plan.blocks.find(b => b.kind === 'build' && b.enabled)
  if (!build) return undefined
  const row = (await db.select().from(nodeRuns).where(and(eq(nodeRuns.runId, ctx.runId), eq(nodeRuns.blockId, build.id))))[0]
  return row?.summary ? clip(redact(row.summary), SUMMARY_MAX) : undefined
}

/**
 * One reader: up to MAX_ATTEMPTS tries, its steps on the shared node, its verdict recorded with its focus. An answer the
 * app could not read is asked for once more, with a reminder of the form it reads, inside this same step; only a second
 * unreadable answer leaves this reader's part of the review missing.
 */
async function readFor(ctx: Context, nodeId: string, focus: Focus, since: { paths: string[]; diff: string; more?: number } | null): Promise<Reading> {
  const { runId, plan, block, deps } = ctx
  const provider = deps.resolveProvider(plan.providerId)
  const builderSummary = await builderSummaryOf(ctx)
  const review = { focus, ...(builderSummary ? { builderSummary } : {}), ...(since ? { since } : {}) }
  const say = (text: string, attempt: number, extra: Record<string, unknown> = {}) =>
    withTx(runId, async tx => {
      const node = await freshNode(nodeId, tx)
      if (node.state === 'running') {
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt, text: clip(redact(text), 240), ...extra } }, tx)
      }
    })

  await say(strings.review.reading[focus], 1)
  let reminded = false
  // `attempt` numbers every call of this reader on the card; `failures` counts only the calls that did not finish.
  for (let attempt = 1, failures = 1; ; attempt++) {
    const workspace: Workspace = { ...ctx.workspace, review: reminded ? { ...review, reminder: true } : review }
    const result = await runAttempt(provider, block, plan.request, runId, workspace, null, [], text => say(text, attempt), () => {})
    if (result.kind === 'cancelled') return { outcome: 'cancelled' }
    if (result.kind === 'done') {
      const again = !reminded
      const reading = await withTx(runId, async (tx): Promise<Reading | 'again'> => {
        const node = await freshNode(nodeId, tx)
        if (node.state !== 'running') return { outcome: outcomeOf(node.state) ?? 'cancelled' }
        await recordDoneFacts(tx, node, result)
        if (result.review) {
          await appendEventSync({ runId, nodeRunId: node.id, type: 'node.reviewed', payload: { blockId: block.id, focus, verdict: result.review.verdict, findings: result.review.findings } }, tx)
          return { review: result.review }
        }
        // For a developer, never shown: why the answer gave no verdict and how it ended (already redacted and clipped).
        const why = result.unreadable ? { why: result.unreadable.why, answer: result.unreadable.answer } : {}
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.review_unreadable', payload: { blockId: block.id, focus, attempt, ...why, ...(again ? { retried: true } : {}) } }, tx)
        if (again) {
          await appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt: attempt + 1, text: strings.review.askedAgain, retry: true } }, tx)
          return 'again'
        }
        // An answer without a verdict is said on the card and kept on the record: this reader's part of the review is missing.
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.step', payload: { blockId: block.id, attempt, text: strings.review.unreadable } }, tx)
        return { review: null, unreadable: true }
      })
      if (reading !== 'again') return reading
      reminded = true
      continue
    }
    const failure = describeFailure(result, block)
    if (canRetry(failures, result)) {
      failures++
      await say(strings.run.retrying, attempt + 1, { retry: true, previousCause: failure.cause, previousMessage: failure.message, ...(failure.detail ? { previousDetail: failure.detail } : {}) })
      continue
    }
    return { failed: { ...failure, messageSource: result.kind === 'error' ? result.source : 'system', attempt } }
  }
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

/** `unreadable`: how many readers gave no verdict in this pass; the gate and Approve read it from the closing event. */
async function closeReview(runId: string, nodeId: string, summary: string, unreadable: number): Promise<Outcome['outcome']> {
  return withTx(runId, async tx => {
    const node = await freshNode(nodeId, tx)
    const settled = outcomeOf(node.state)
    if (settled) return settled
    if (!canTransition(node.state as NodeState, 'passed')) return 'cancelled'
    return (await transitionNode(tx, node, 'passed', { type: 'node.completed', payload: { summary, summarySource: 'system', unreadable } }, { summary })) ? 'passed' : 'cancelled'
  })
}

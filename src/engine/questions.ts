import { and, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { canTransition, type NodeState } from '@/domain/states'
import { findings, nodeRuns, questions, runs } from '@/db/schema'
import { localActor } from '@/engine/approvals'
import { appendEventSync, lockRun } from '@/engine/events'
import { QUESTION_ANSWERED } from '@/engine/inngest/client'
import { runPlace } from '@/engine/machine'
import { addEntry } from '@/engine/register'
import { markWaiting, type Send } from '@/engine/relay'
import { strings } from '@/ui/strings'

// A decision that is the person's reaches them as a question with options, and the run waits for the answer. The
// question and its answer are rows first, then events; the executor reads the row, never the event alone.

export type Option = { id: string; label: string; means: string }
export type Question = {
  id: string
  runId: string
  nodeRunId: string
  findingId: string | null
  /** 'plan': the planner's own question, asked before it plans again; it is about no finding. */
  kind: 'finding' | 'fix_held' | 'plan'
  text: string
  why: string
  /** What the AI reviewer said, in its own words: shown one click away and labelled as the AI's. */
  detail: string | null
  options: Option[]
  recommended: string | null
  /** Register numbers of the entries this question concerns. */
  touches: number[]
  state: 'open' | 'answered'
  answerOption: string | null
  answerText: string | null
  actor: string | null
  answeredAt: string | null
}

/** Always the last choice: do nothing about this. */
export const LEAVE = 'leave'
/** Never a listed choice; always accepted as an answer when it comes with the person's own words. */
export const OTHER = 'other'

// Strings come from agents and from a form; they are trimmed, then cut to these lengths.
const MAX_TEXT = 500
const MAX_WHY = 1000
const MAX_DETAIL = 1000
const MAX_LABEL = 80
const MAX_MEANS = 300
const MAX_ANSWER = 1000
// A planner question's paths: as many as one job may name, each as long as a job's path may be.
const MAX_PATHS = 20
const MAX_PATH = 300

export class QuestionError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'QuestionError'
  }
}

const cap = (s: string, max: number) => s.trim().slice(0, max)
const now = () => new Date().toISOString()

type Row = typeof questions.$inferSelect

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toQuestion(r: Row): Question {
  return {
    id: r.id,
    runId: r.runId,
    nodeRunId: r.nodeRunId,
    findingId: r.findingId,
    kind: r.kind as Question['kind'],
    text: r.text,
    why: r.why,
    detail: r.detail,
    options: parse<Option[]>(r.optionsJson, []),
    recommended: r.recommended,
    touches: parse<number[]>(r.touchesJson, []),
    state: r.state as Question['state'],
    answerOption: r.answerOption,
    answerText: r.answerText,
    actor: r.actor,
    answeredAt: r.answeredAt,
  }
}

/** The options as they are kept: the caller's own in their order, then the choice to leave it. Throws on a list that cannot be answered. */
function normaliseOptions(given: readonly Option[], recommended: string | null): { options: Option[]; recommended: string | null } {
  if (given.length === 0) throw new Error('A question needs at least one option.')
  const seen = new Set<string>()
  const listed: Option[] = given.map(o => {
    const id = o.id.trim()
    if (!id) throw new Error('An option needs an id.')
    if (id === OTHER) throw new Error(`"${OTHER}" is always allowed and is not a listed option.`)
    if (seen.has(id)) throw new Error(`Two options share the id "${id}".`)
    seen.add(id)
    const label = cap(o.label, MAX_LABEL)
    if (!label) throw new Error(`Option "${id}" needs a label.`)
    return { id, label, means: cap(o.means, MAX_MEANS) }
  })
  // The choice to leave it is always last: the caller's own words for it are kept, the app's are used when it has none.
  const options = [...listed.filter(o => o.id !== LEAVE), listed.find(o => o.id === LEAVE) ?? { id: LEAVE, label: strings.question.leaveLabel, means: strings.question.leaveMeans }]
  if (recommended !== null && !options.some(o => o.id === recommended)) throw new Error(`The recommended option "${recommended}" is not one of the options.`)
  return { options, recommended }
}

const runCan = (from: string, to: NodeState) => canTransition(from as NodeState, to)

/**
 * Asks the person, and parks the run (and the node) on the answer, as a human check does. Asking the same thing again
 * (a retried step) returns the question it already is, in whatever state, and changes nothing: the caller must branch
 * on `state` (`answered` means go straight to `takeAnswer`). Asking something else while one is open throws.
 * The planner may ask again on the same node after its last answer was taken: that one is a new question, never the
 * old one. `paths`: what a planner question is about, kept so a decision made from its answer stays on those files.
 */
export async function askPerson(
  runId: string,
  nodeRunId: string,
  q: Pick<Question, 'findingId' | 'kind' | 'text' | 'why' | 'options' | 'recommended' | 'touches'> & { detail?: string | null; paths?: readonly string[] },
): Promise<Question> {
  const text = cap(q.text, MAX_TEXT)
  if (!text) throw new Error('A question needs its words.')
  const { options, recommended } = normaliseOptions(q.options, q.recommended)
  const touches = [...new Set(q.touches.filter(n => Number.isInteger(n) && n > 0))]
  const paths = q.kind === 'plan' ? JSON.stringify([...new Set((q.paths ?? []).map(p => p.trim().slice(0, MAX_PATH)).filter(Boolean))].slice(0, MAX_PATHS)) : null
  const asked = await db.transaction(async tx => {
    await lockRun(tx, runId)
    const run = (await tx.select().from(runs).where(eq(runs.id, runId)))[0]
    if (!run) throw new QuestionError(strings.errors.runNotFound, 404)
    const same = (
      await tx.select().from(questions).where(and(
        eq(questions.runId, runId),
        eq(questions.nodeRunId, nodeRunId),
        eq(questions.kind, q.kind),
        q.findingId === null ? isNull(questions.findingId) : eq(questions.findingId, q.findingId),
        // A planner question already taken was turned into a plan: the next one on this node is new.
        ...(q.kind === 'plan' ? [isNull(questions.consumedAt)] : []),
      ))
    )[0]
    if (same) return toQuestion(same)
    const open = (await tx.select().from(questions).where(and(eq(questions.runId, runId), eq(questions.state, 'open'))))[0]
    if (open) throw new QuestionError(strings.question.anotherOpen, 409)
    const node = (await tx.select().from(nodeRuns).where(and(eq(nodeRuns.id, nodeRunId), eq(nodeRuns.runId, runId))))[0]
    if (run.status !== 'running' || !node || node.state !== 'running' || !runCan(run.status, 'waiting_approval') || !runCan(node.state, 'waiting_approval')) throw new QuestionError(strings.question.notWaiting, 409)
    const row = {
      id: ulid(),
      projectId: run.projectId,
      runId,
      nodeRunId,
      findingId: q.findingId,
      kind: q.kind,
      text,
      why: cap(q.why, MAX_WHY),
      detail: q.detail?.trim() ? cap(q.detail, MAX_DETAIL) : null,
      optionsJson: JSON.stringify(options),
      recommended,
      touchesJson: JSON.stringify(touches),
      paths,
      state: 'open',
      answerOption: null,
      answerText: null,
      actor: null,
      answeredAt: null,
      deliveredAt: null,
      createdAt: now(),
    }
    await tx.insert(questions).values(row)
    // Like a human check: the run's own event first, then the node's, so the log ends on what the person has to act on.
    await tx.update(runs).set({ status: 'waiting_approval' }).where(eq(runs.id, runId))
    await appendEventSync({ runId, type: 'run.waiting_approval', payload: { blockId: node.blockId } }, tx)
    await tx.update(nodeRuns).set({ state: 'waiting_approval' }).where(eq(nodeRuns.id, node.id))
    await appendEventSync({ runId, nodeRunId, type: 'node.question_asked', payload: { blockId: node.blockId, questionId: row.id, kind: q.kind } }, tx)
    return toQuestion(row as Row)
  })
  markWaiting(runId) // the relay watches for an answer given on another computer
  return asked
}

/** The question this run is waiting on, if any (null once the run is cancelled). */
export async function openQuestion(runId: string): Promise<Question | null> {
  const row = (await db.select().from(questions).where(and(eq(questions.runId, runId), eq(questions.state, 'open'))))[0]
  if (!row) return null
  // A question left open on a run that was cancelled is not waited on by anyone.
  const run = (await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)))[0]
  return run?.status === 'waiting_approval' ? toQuestion(row) : null
}

/** The question with its answer; null until it is answered. What the executor acts on: the row, never the event. */
export async function takeAnswer(questionId: string): Promise<Question | null> {
  const row = (await db.select().from(questions).where(eq(questions.id, questionId)))[0]
  return row && row.state === 'answered' ? toQuestion(row) : null
}

/**
 * The answer, read by the run that goes on with it: from then on it is taken, and the relay stops telling the run
 * about it. Null until it is answered. A second read returns the same answer.
 */
export async function consumeAnswer(questionId: string): Promise<Question | null> {
  const answer = await takeAnswer(questionId)
  if (answer) await db.update(questions).set({ consumedAt: now() }).where(and(eq(questions.id, questionId), isNull(questions.consumedAt)))
  return answer
}

/**
 * The decision the project keeps from an answer, or null when there is none to keep: only an answer with the person's
 * own words is one. It says what it was about (from the finding, in the app's words), what they chose, and their words;
 * never the question's own sentence, which reads the same for every problem of a kind. A bare choice (fix, keep, undo,
 * leave) is kept on the problem's own line in the register.
 */
export function decisionText(q: Question, finding?: { type: 'logic' | 'security' | 'effect'; file?: string }): string | null {
  const words = q.answerText?.trim() ?? ''
  if (!words) return null
  const label = q.options.find(o => o.id === q.answerOption)?.label
  const choice = q.answerOption === OTHER || !q.answerOption ? null : strings.question.chose(q.kind, q.answerOption, label)
  return strings.question.decision({ about: strings.question.about(q.kind, finding, q.text), choice, words })
}

export type AnswerDeps = { send: Send; actor?: () => string }

/**
 * The person's answer: checked and recorded in one transaction (answer, run and node moving on, the event, the
 * register entry), then told to the run. If the run cannot be told now, or it belongs to another computer, the answer
 * stays recorded and the relay tells it later.
 */
export async function answerQuestion(questionId: string, a: { option: string; text?: string }, deps: AnswerDeps): Promise<Question> {
  const first = (await db.select({ runId: questions.runId }).from(questions).where(eq(questions.id, questionId)))[0]
  if (!first) throw new QuestionError(strings.question.notFound, 404)
  const answered = await db.transaction(async tx => {
    await lockRun(tx, first.runId)
    const row = (await tx.select().from(questions).where(eq(questions.id, questionId)).for('update'))[0]
    if (!row) throw new QuestionError(strings.question.notFound, 404)
    if (row.state !== 'open') throw new QuestionError(strings.question.alreadyAnswered, 409)
    const run = (await tx.select().from(runs).where(eq(runs.id, row.runId)))[0]
    const node = (await tx.select().from(nodeRuns).where(eq(nodeRuns.id, row.nodeRunId)))[0]
    if (!run || !node || run.status !== 'waiting_approval' || node.state !== 'waiting_approval' || !runCan(run.status, 'running') || !runCan(node.state, 'running')) throw new QuestionError(strings.question.notWaiting, 409)
    const option = a.option.trim()
    const words = cap(a.text ?? '', MAX_ANSWER)
    if (option === OTHER) {
      if (!words) throw new QuestionError(strings.question.needWords, 409)
    } else if (!parse<Option[]>(row.optionsJson, []).some(o => o.id === option)) {
      throw new QuestionError(strings.question.unknownOption, 409)
    }
    const fields = { state: 'answered', answerOption: option, answerText: words || null, actor: (deps.actor ?? localActor)(), answeredAt: now() }
    await tx.update(questions).set(fields).where(eq(questions.id, questionId))
    await tx.update(nodeRuns).set({ state: 'running' }).where(eq(nodeRuns.id, node.id))
    await appendEventSync({ runId: run.id, nodeRunId: node.id, type: 'node.question_answered', payload: { blockId: node.blockId, questionId, option } }, tx)
    await tx.update(runs).set({ status: 'running' }).where(eq(runs.id, run.id))
    await appendEventSync({ runId: run.id, type: 'run.started', payload: { resumed: true } }, tx)
    const done = toQuestion({ ...row, ...fields })
    const about = row.findingId ? (await tx.select({ type: findings.type, file: findings.file }).from(findings).where(eq(findings.id, row.findingId)))[0] : undefined
    const text = decisionText(done, about ? { type: about.type as 'logic' | 'security' | 'effect', ...(about.file ? { file: about.file } : {}) } : undefined)
    // The decision stays on the files it was about, so a later change to them stops for the person: the finding's
    // file, or what the planner's question named.
    const paths = row.kind === 'plan' ? parse<string[]>(row.paths ?? '[]', []).filter((p): p is string => typeof p === 'string') : about?.file ? [about.file] : []
    if (text) await addEntry(run.projectId, { kind: 'decision', text, paths, source: 'question', runId: run.id }, tx)
    return done
  })
  await tell(answered, deps.send)
  return answered
}

// Claimed and marked before it is sent, so the relay never sends it twice; handed back to the relay if sending fails.
async function tell(q: Question, send: Send): Promise<void> {
  if (!(await runPlace(q.runId)).here) return
  const claimed = await db.update(questions).set({ deliveredAt: now() }).where(and(eq(questions.id, q.id), isNull(questions.deliveredAt))).returning({ id: questions.id })
  if (claimed.length === 0) return
  try {
    await send({ name: QUESTION_ANSWERED, data: { runId: q.runId, questionId: q.id } })
    // Told; the relay still watches until the run has taken it, in case the run was not listening yet.
    markWaiting(q.runId)
  } catch {
    await db.update(questions).set({ deliveredAt: null }).where(eq(questions.id, q.id))
    markWaiting(q.runId) // so the relay keeps looking until it has been told
  }
}

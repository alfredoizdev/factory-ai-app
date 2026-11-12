import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, nodeRuns, questions } from '@/db/schema'
import { appendEventSync, lockRun } from '@/engine/events'
import { jsonObjectsFromEnd } from '@/engine/json-objects'
import { clip, redact } from '@/engine/redact'
import { strings } from '@/ui/strings'

// The plan: the request split into jobs, each with how to tell it is done. A planner (a model, reading the project
// without changing it) proposes it; the person reads it, edits it, and says when to build. What the planner wrote is
// its claim; what the person confirms is what the builder is given. Both are on the record as events.

export type Job = { title: string; done: string[]; paths?: string[] } // paths absent: the planner gave none
export type PlanOption = { id: string; label: string; means: string }
export type PlanQuestion = { text: string; why: string; paths: string[]; options: PlanOption[] }
export type PlannerAnswer = { jobs: Job[]; question: PlanQuestion | 'unreadable' | null }

export const MAX_JOBS = 8
export const MAX_PATHS_PER_JOB = 20
export const MAX_PLAN_OPTIONS = 4
const MAX_TITLE = 200
const MAX_DONE = 5
const MAX_DONE_TEXT = 200
const MAX_PATH = 300
const OPTION_ID = /^[a-z0-9_-]{1,20}$/
const RESERVED_IDS = new Set(['other', 'leave'])

/** File names as the planner wrote them (a single string is a list of one): trimmed, "./" dropped, bounded. Not redacted. */
function cleanPaths(raw: unknown): string[] | undefined {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null
  if (!list) return undefined
  return list
    .filter((p): p is string => typeof p === 'string')
    .map(p => p.trim().replace(/^(\.\/)+/, ''))
    .filter(p => p !== '')
    .slice(0, MAX_PATHS_PER_JOB)
    .map(p => clip(p, MAX_PATH))
}

/** Jobs as given (by a planner or a person), cleaned and bounded; null when there is not one usable job. */
export function cleanJobs(raw: unknown): Job[] | null {
  if (!Array.isArray(raw)) return null
  const jobs: Job[] = []
  for (const j of raw.slice(0, MAX_JOBS) as { title?: unknown; done?: unknown; paths?: unknown }[]) {
    const title = typeof j?.title === 'string' ? clip(redact(j.title.trim()), MAX_TITLE) : ''
    if (title === '') continue
    const done = (Array.isArray(j.done) ? j.done : [])
      .filter((d): d is string => typeof d === 'string' && d.trim() !== '')
      .slice(0, MAX_DONE)
      .map(d => clip(redact(d.trim()), MAX_DONE_TEXT))
    const paths = cleanPaths(j.paths)
    jobs.push(paths ? { title, done, paths } : { title, done })
  }
  return jobs.length > 0 ? jobs : null
}

const asText = (v: unknown, max: number): string => (typeof v === 'string' ? clip(redact(v.trim()), max) : '')

/** The planner's question: null when it asked none; 'unreadable' when it asked one the person could not be given. */
function cleanQuestion(raw: unknown): PlanQuestion | 'unreadable' | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'unreadable'
  const q = raw as { text?: unknown; why?: unknown; paths?: unknown; options?: unknown }
  const text = asText(q.text, 500)
  const options: PlanOption[] = []
  for (const o of (Array.isArray(q.options) ? q.options : []) as { id?: unknown; label?: unknown; means?: unknown }[]) {
    const id = typeof o?.id === 'string' ? o.id.trim() : ''
    const label = asText(o?.label, 80)
    if (!OPTION_ID.test(id) || RESERVED_IDS.has(id) || options.some(x => x.id === id) || label === '') continue
    options.push({ id, label, means: asText(o.means, 300) })
  }
  if (text === '' || options.length < 2) return 'unreadable'
  return { text, why: asText(q.why, 1000), paths: cleanPaths(q.paths) ?? [], options: options.slice(0, MAX_PLAN_OPTIONS) }
}

/** The planner's answer: jobs and question, both from the last JSON object with usable "jobs"; null when there is none. */
export function readPlannerAnswer(text: string): PlannerAnswer | null {
  for (const value of jsonObjectsFromEnd(text)) {
    const jobs = cleanJobs(value.jobs)
    if (jobs) return { jobs, question: cleanQuestion(value.question) }
  }
  return null
}

/** The planner's jobs, from the last JSON object with usable "jobs" in its answer; null when there is none. */
export function parsePlan(text: string): Job[] | null {
  return readPlannerAnswer(text)?.jobs ?? null
}

/** The jobs as the builder reads them: a numbered work list with how to tell each is done. */
export function workList(jobs: readonly Job[]): string {
  return jobs
    .map((j, i) => [`${i + 1}. ${j.title}`, ...j.done.map(d => `   - Done when: ${d}`)].join('\n'))
    .join('\n')
}

type Planned = { jobs: Job[]; by: 'planner' | 'person' }

/** The run's plan as it stands: the last one recorded, by the planner or the person. */
export async function currentPlan(runId: string): Promise<Planned | null> {
  const row = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'node.planned'))).orderBy(desc(events.sequence)))[0]
  if (!row) return null
  const p = JSON.parse(row.payloadJson) as { jobs?: unknown; by?: unknown }
  const jobs = cleanJobs(p.jobs)
  return jobs ? { jobs, by: p.by === 'person' ? 'person' : 'planner' } : null
}

export type PlanDecision = { action: 'build' } | { action: 'replan'; note: string }

/** What the person last said about the plan, if they said anything since it was last proposed. */
export async function planDecision(runId: string): Promise<PlanDecision | null> {
  const rows = (await db.select().from(events).where(eq(events.runId, runId)).orderBy(desc(events.sequence)))
  for (const row of rows) {
    if (row.type === 'node.plan_proposed') return null // the planner proposed after the last decision: nothing decided on it
    if (row.type !== 'node.plan_decided') continue
    const p = JSON.parse(row.payloadJson) as { action?: unknown; note?: unknown }
    if (p.action === 'build') return { action: 'build' }
    if (p.action === 'replan' && typeof p.note === 'string') return { action: 'replan', note: p.note }
    return null
  }
  return null
}

export class PlanError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message)
  }
}

/**
 * Records the person's word on a plan waiting for them: build it (with their edited jobs), or plan again with a note.
 * Only while the plan block waits; the caller then tells the run to look.
 */
/** `delivered`: the recording computer tells the run itself, so the relay must not tell it again. */
export async function decidePlan(runId: string, decision: { action: 'build'; jobs: unknown } | { action: 'replan'; note: string }, delivered = false): Promise<void> {
  await db.transaction(
    async tx => {
      await lockRun(tx, runId)
      let node: (typeof nodeRuns.$inferSelect) | undefined
      for (const n of await tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))) {
        if (n.state === 'waiting_approval' && (await isPlanNode(tx, runId, n.id))) {
          node = n
          break
        }
      }
      if (!node) throw new PlanError(strings.plan.notWaiting)
      // While the planner's question waits, the node waits on that answer, not on a word about an earlier plan.
      if ((await tx.select({ id: questions.id }).from(questions).where(and(eq(questions.nodeRunId, node.id), eq(questions.state, 'open'))))[0]) throw new PlanError(strings.plan.notWaiting)
      if (decision.action === 'build') {
        const jobs = cleanJobs(decision.jobs)
        if (!jobs) throw new PlanError(strings.plan.needAJob)
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.planned', payload: { blockId: node.blockId, jobs, by: 'person' } }, tx)
        const word = await appendEventSync({ runId, nodeRunId: node.id, type: 'node.plan_decided', payload: { blockId: node.blockId, action: 'build' } }, tx)
        if (delivered) await tx.update(events).set({ deliveredAt: new Date().toISOString() }).where(eq(events.id, word.id))
      } else {
        const note = clip(redact(decision.note.trim()), 1000)
        if (note === '') throw new PlanError(strings.plan.needANote)
        const word = await appendEventSync({ runId, nodeRunId: node.id, type: 'node.plan_decided', payload: { blockId: node.blockId, action: 'replan', note } }, tx)
        if (delivered) await tx.update(events).set({ deliveredAt: new Date().toISOString() }).where(eq(events.id, word.id))
      }
    },
  )
}

// A node is the plan's when the planner proposed on it.
async function isPlanNode(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], runId: string, nodeRunId: string): Promise<boolean> {
  return (await tx.select().from(events).where(and(eq(events.runId, runId), eq(events.nodeRunId, nodeRunId), eq(events.type, 'node.plan_proposed'))))[0] !== undefined
}

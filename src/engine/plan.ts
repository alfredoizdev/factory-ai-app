import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, nodeRuns } from '@/db/schema'
import { appendEventSync } from '@/engine/events'
import { clip, redact } from '@/engine/redact'
import { strings } from '@/ui/strings'

// The plan: the request split into jobs, each with how to tell it is done. A planner (a model, reading the project
// without changing it) proposes it; the person reads it, edits it, and says when to build. What the planner wrote is
// its claim; what the person confirms is what the builder is given. Both are on the record as events.

export type Job = { title: string; done: string[] }

export const MAX_JOBS = 8
const MAX_TITLE = 200
const MAX_DONE = 5
const MAX_DONE_TEXT = 200

/** Jobs as given (by a planner or a person), cleaned and bounded; null when there is not one usable job. */
export function cleanJobs(raw: unknown): Job[] | null {
  if (!Array.isArray(raw)) return null
  const jobs: Job[] = []
  for (const j of raw.slice(0, MAX_JOBS) as { title?: unknown; done?: unknown }[]) {
    const title = typeof j?.title === 'string' ? clip(redact(j.title.trim()), MAX_TITLE) : ''
    if (title === '') continue
    const done = (Array.isArray(j.done) ? j.done : [])
      .filter((d): d is string => typeof d === 'string' && d.trim() !== '')
      .slice(0, MAX_DONE)
      .map(d => clip(redact(d.trim()), MAX_DONE_TEXT))
    jobs.push({ title, done })
  }
  return jobs.length > 0 ? jobs : null
}

/** The planner's jobs, from the last JSON object with "jobs" in its answer; null when there is none. */
export function parsePlan(text: string): Job[] | null {
  const candidates = [...text.matchAll(/\{[\s\S]*?"jobs"[\s\S]*\}/g)].map(m => m[0])
  for (const raw of candidates.reverse()) {
    // The greedy match may run past the object's end into later text: try shorter endings until one parses.
    for (let end = raw.length - 1; end > 0; end = raw.lastIndexOf('}', end - 1)) {
      try {
        const jobs = cleanJobs((JSON.parse(raw.slice(0, end + 1)) as { jobs?: unknown }).jobs)
        if (jobs) return jobs
      } catch {
        // not this ending
      }
    }
  }
  return null
}

/** The jobs as the builder reads them: a numbered work list with how to tell each is done. */
export function workList(jobs: readonly Job[]): string {
  return jobs
    .map((j, i) => [`${i + 1}. ${j.title}`, ...j.done.map(d => `   - Done when: ${d}`)].join('\n'))
    .join('\n')
}

type Planned = { jobs: Job[]; by: 'planner' | 'person' }

/** The run's plan as it stands: the last one recorded, by the planner or the person. */
export function currentPlan(runId: string): Planned | null {
  const row = db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'node.planned'))).orderBy(desc(events.sequence)).get()
  if (!row) return null
  const p = JSON.parse(row.payloadJson) as { jobs?: unknown; by?: unknown }
  const jobs = cleanJobs(p.jobs)
  return jobs ? { jobs, by: p.by === 'person' ? 'person' : 'planner' } : null
}

export type PlanDecision = { action: 'build' } | { action: 'replan'; note: string }

/** What the person last said about the plan, if they said anything since it was last proposed. */
export function planDecision(runId: string): PlanDecision | null {
  const rows = db.select().from(events).where(eq(events.runId, runId)).orderBy(desc(events.sequence)).all()
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
export function decidePlan(runId: string, decision: { action: 'build'; jobs: unknown } | { action: 'replan'; note: string }): void {
  db.transaction(
    tx => {
      const node = tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId !== undefined && n.state === 'waiting_approval' && isPlanNode(tx, runId, n.id))
      if (!node) throw new PlanError(strings.plan.notWaiting)
      if (decision.action === 'build') {
        const jobs = cleanJobs(decision.jobs)
        if (!jobs) throw new PlanError(strings.plan.needAJob)
        appendEventSync({ runId, nodeRunId: node.id, type: 'node.planned', payload: { blockId: node.blockId, jobs, by: 'person' } }, tx)
        appendEventSync({ runId, nodeRunId: node.id, type: 'node.plan_decided', payload: { blockId: node.blockId, action: 'build' } }, tx)
      } else {
        const note = clip(redact(decision.note.trim()), 1000)
        if (note === '') throw new PlanError(strings.plan.needANote)
        appendEventSync({ runId, nodeRunId: node.id, type: 'node.plan_decided', payload: { blockId: node.blockId, action: 'replan', note } }, tx)
      }
    },
    { behavior: 'immediate' },
  )
}

// A node is the plan's when the planner proposed on it.
function isPlanNode(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], runId: string, nodeRunId: string): boolean {
  return tx.select().from(events).where(and(eq(events.runId, runId), eq(events.nodeRunId, nodeRunId), eq(events.type, 'node.plan_proposed'))).get() !== undefined
}

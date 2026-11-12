import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, events, questions, runs } from '@/db/schema'
import { thisMachine } from '@/engine/machine'

// The relay: a decision made on one computer about a run that executes on another. Every decision is recorded first
// (an approvals row, a node.plan_decided event); the computer that records it tells the run's Inngest only when the
// run is its own. Every computer running the app checks, every few seconds, for decisions on its own runs that
// nobody told it about, tells its Inngest, and marks them told. Nothing is sent twice: the mark is set in the same
// statement that claims the row.

export const RELAY_EVERY_MS = 5000
/**
 * An answer told to the run that the run has not taken this long after is told again: the run may not have been
 * listening yet when it was told (it was asked and answered within a moment), and nothing else would tell it.
 */
export const RESEND_AFTER_MS = 30_000

// The runs of this computer that wait on a person, kept in memory so the relay asks the database nothing while there
// are none (an idle app must let Neon sleep). Filled once at start, added to when a run parks here, and pruned after
// each pass to those still waiting.
const g = globalThis as { __factoryWaiting?: Set<string>; __factoryWaitingSeeded?: boolean }
const waiting = (g.__factoryWaiting ??= new Set())

/** A run of this computer started waiting on a person (its gate or its plan). */
export function markWaiting(runId: string): void {
  waiting.add(runId)
}

/** An answer the run has not taken yet (whether or not it was told): the row is the truth, the event only says "look". */
const untaken = and(eq(questions.state, 'answered'), isNull(questions.consumedAt))

/**
 * Which of this computer's runs wait, read once when the app starts: runs that parked before a restart, and runs whose
 * question was answered (here while the app was down, or on another computer) but that have not taken the answer yet.
 */
export async function seedWaiting(): Promise<void> {
  if (g.__factoryWaitingSeeded) return
  const mine = eq(runs.machineId, thisMachine().id)
  const rows = await db.select({ id: runs.id }).from(runs).where(and(mine, eq(runs.status, 'waiting_approval')))
  for (const r of rows) waiting.add(r.id)
  const answered = await db
    .select({ id: questions.runId })
    .from(questions)
    .where(and(untaken, inArray(questions.runId, db.select({ id: runs.id }).from(runs).where(and(mine, eq(runs.status, 'running'))))))
  for (const a of answered) waiting.add(a.id)
  g.__factoryWaitingSeeded = true
}

/** One relay pass: nothing at all when no run of this computer waits; otherwise deliver, then forget runs that moved. */
export async function relayTick(send: Send, approvalEvent: string, planEvent: string, questionEvent?: string): Promise<number> {
  if (waiting.size === 0) return 0
  const told = await deliverPending(send, approvalEvent, planEvent, questionEvent)
  const ids = [...waiting]
  const still = await db.select({ id: runs.id }).from(runs).where(and(inArray(runs.id, ids), eq(runs.status, 'waiting_approval')))
  const keep = new Set(still.map(r => r.id))
  // An answer the run has not taken yet keeps its run watched, though the run is no longer waiting: it may need telling again.
  const untold = await db.select({ id: questions.runId }).from(questions).where(and(inArray(questions.runId, ids), untaken))
  for (const q of untold) keep.add(q.id)
  for (const id of ids) if (!keep.has(id)) waiting.delete(id)
  return told
}

export const waitingCount = () => waiting.size

export type Send = (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>

const now = () => new Date().toISOString()

/** Hands this run's latest plan decision back to the relay, after telling the run failed. */
export async function markPlanDecisionsUndelivered(runId: string): Promise<void> {
  const last = (await db.select({ id: events.id }).from(events).where(and(eq(events.runId, runId), eq(events.type, 'node.plan_decided'))).orderBy(desc(events.sequence)).limit(1))[0]
  if (last) await db.update(events).set({ deliveredAt: null }).where(eq(events.id, last.id))
}

/** Tells this computer's Inngest about decisions on its runs that were made elsewhere. Returns how many. */
export async function deliverPending(send: Send, approvalEvent: string, planEvent: string, questionEvent?: string): Promise<number> {
  const mine = db.select({ id: runs.id }).from(runs).where(eq(runs.machineId, thisMachine().id))
  let told = 0
  // Claimed and marked in one statement, so two passes (or two processes) never send one decision twice.
  const decided = await db
    .update(approvals)
    .set({ deliveredAt: now() })
    .where(and(isNull(approvals.deliveredAt), isNull(approvals.consumedAt), inArray(approvals.runId, mine)))
    .returning({ runId: approvals.runId, decision: approvals.decision })
  for (const d of decided) {
    try {
      await send({ name: approvalEvent, data: { runId: d.runId, decision: d.decision } })
      told++
    } catch {
      await db.update(approvals).set({ deliveredAt: null }).where(and(eq(approvals.runId, d.runId), eq(approvals.decision, d.decision), isNull(approvals.consumedAt)))
    }
  }
  const words = await db
    .update(events)
    .set({ deliveredAt: now() })
    .where(and(eq(events.type, 'node.plan_decided'), isNull(events.deliveredAt), inArray(events.runId, mine)))
    .returning({ id: events.id, runId: events.runId })
  for (const w of words) {
    try {
      await send({ name: planEvent, data: { runId: w.runId } })
      told++
    } catch {
      await db.update(events).set({ deliveredAt: null }).where(eq(events.id, w.id))
    }
  }
  if (questionEvent) {
    // Not told yet, or told a while ago and still not taken; only for a run that is going (a cancelled run waits on nothing).
    const going = db.select({ id: runs.id }).from(runs).where(and(eq(runs.machineId, thisMachine().id), eq(runs.status, 'running')))
    const stale = new Date(Date.now() - RESEND_AFTER_MS).toISOString()
    const answered = await db
      .update(questions)
      .set({ deliveredAt: now() })
      .where(and(untaken, or(isNull(questions.deliveredAt), lt(questions.deliveredAt, stale)), inArray(questions.runId, going)))
      .returning({ id: questions.id, runId: questions.runId })
    for (const a of answered) {
      try {
        await send({ name: questionEvent, data: { runId: a.runId, questionId: a.id } })
        told++
      } catch {
        await db.update(questions).set({ deliveredAt: null }).where(eq(questions.id, a.id))
      }
    }
  }
  return told
}

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, events, runs } from '@/db/schema'
import { thisMachine } from '@/engine/machine'

// The relay: a decision made on one computer about a run that executes on another. Every decision is recorded first
// (an approvals row, a node.plan_decided event); the computer that records it tells the run's Inngest only when the
// run is its own. Every computer running the app checks, every few seconds, for decisions on its own runs that
// nobody told it about, tells its Inngest, and marks them told. Nothing is sent twice: the mark is set in the same
// statement that claims the row.

export const RELAY_EVERY_MS = 5000

export type Send = (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>

const now = () => new Date().toISOString()

/** Hands this run's latest plan decision back to the relay, after telling the run failed. */
export async function markPlanDecisionsUndelivered(runId: string): Promise<void> {
  const last = (await db.select({ id: events.id }).from(events).where(and(eq(events.runId, runId), eq(events.type, 'node.plan_decided'))).orderBy(desc(events.sequence)).limit(1))[0]
  if (last) await db.update(events).set({ deliveredAt: null }).where(eq(events.id, last.id))
}

/** Tells this computer's Inngest about decisions on its runs that were made elsewhere. Returns how many. */
export async function deliverPending(send: Send, approvalEvent: string, planEvent: string): Promise<number> {
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
  return told
}

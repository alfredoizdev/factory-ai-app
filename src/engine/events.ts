import { and, eq, gt, asc, max } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { events, runs } from '@/db/schema'

// The append-only event log: the single source of truth the canvas reads. This module records what
// happened; it never infers state. It does no redaction: callers must not put secrets in a payload.

export type RunEventType = 'run.created' | 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled'
export type NodeEventType =
  | 'node.queued' | 'node.started' | 'node.step' | 'node.completed'
  | 'node.failed' | 'node.skipped' | 'node.waiting_approval'
export type EventType = RunEventType | NodeEventType

// Events carry only nodeRunId, so every node.* payload names its block: the client maps an event to a block without a join.
export type NodeEventPayload = { blockId: string } & Record<string, unknown>

export type EventRow = {
  id: string
  runId: string
  nodeRunId: string | null
  sequence: number
  type: EventType
  payload: unknown
  createdAt: string
}

export type AppendEventInput =
  | { runId: string; nodeRunId?: string; type: RunEventType; payload?: unknown }
  | { runId: string; nodeRunId?: string; type: NodeEventType; payload: NodeEventPayload }

function toRow(r: typeof events.$inferSelect): EventRow {
  return {
    id: r.id,
    runId: r.runId,
    nodeRunId: r.nodeRunId,
    sequence: r.sequence,
    type: r.type as EventType,
    payload: JSON.parse(r.payloadJson) as unknown,
    createdAt: r.createdAt,
  }
}

export async function appendEvent(input: AppendEventInput): Promise<EventRow> {
  // Read-max and insert share one transaction (better-sqlite3 runs it synchronously, taking the write lock),
  // so concurrent appends cannot read the same max. The unique (runId, sequence) index is the backstop.
  const row = db.transaction(tx => {
    const run = tx.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, input.runId)).get()
    if (!run) throw new Error(`FOREIGN KEY constraint failed: run ${input.runId} does not exist`)
    const top = tx.select({ m: max(events.sequence) }).from(events).where(eq(events.runId, input.runId)).get()
    return tx
      .insert(events)
      .values({
        id: ulid(),
        projectId: run.projectId,
        runId: input.runId,
        nodeRunId: input.nodeRunId ?? null,
        sequence: (top?.m ?? 0) + 1,
        type: input.type,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get()
  })
  return toRow(row)
}

// afterSequence 0 means everything; sequences start at 1.
export async function eventsSince(runId: string, afterSequence: number): Promise<EventRow[]> {
  const rows = db
    .select()
    .from(events)
    .where(and(eq(events.runId, runId), gt(events.sequence, afterSequence)))
    .orderBy(asc(events.sequence))
    .all()
  return rows.map(toRow)
}

import { and, eq, gt, asc, max } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { events, runs } from '@/db/schema'

// The append-only event log: the single source of truth the canvas reads. This module records what
// happened; it never infers state. It does no redaction: callers must not put secrets in a payload.

export type RunEventType =
  | 'run.created' | 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.waiting_approval'
  // The run's own working copy: branch, path and the commit it started from.
  | 'run.workspace'
export type NodeEventType =
  | 'node.queued' | 'node.started' | 'node.step' | 'node.completed'
  | 'node.failed' | 'node.skipped' | 'node.waiting_approval' | 'node.cancelled'
  // A fact from a non-model process (a test run). Carries numbers only; the output itself stays in the evidence table.
  | 'node.evidence'
  // The measured risk of a run's change, recorded on the human check before it opens or stops.
  | 'node.assessed'
  // A person asked for changes: the block goes back to queued for another round, with their note.
  | 'node.reopened'
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

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Cannot append event: run ${runId} does not exist`)
    this.name = 'RunNotFoundError'
  }
}

export class InvalidEventPayloadError extends Error {
  constructor(type: string) {
    super(`${type} event requires a payload with a non-empty string blockId`)
    this.name = 'InvalidEventPayloadError'
  }
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

// A handle a caller already holds: the db itself, or the tx inside db.transaction(). With a transaction handle the
// event commits or rolls back together with the caller's own writes.
export type DbHandle = Pick<typeof db, 'select' | 'insert' | 'update'>

function insertEvent(h: DbHandle, input: AppendEventInput): EventRow {
  // Runtime guard: the type requires blockId, but a cast bypasses types and '' type-checks.
  if (input.type.startsWith('node.')) {
    const blockId = (input.payload as { blockId?: unknown } | null | undefined)?.blockId
    if (typeof blockId !== 'string' || blockId === '') throw new InvalidEventPayloadError(input.type)
  }
  const run = h.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, input.runId)).get()
  if (!run) throw new RunNotFoundError(input.runId)
  const top = h.select({ m: max(events.sequence) }).from(events).where(eq(events.runId, input.runId)).get()
  return toRow(
    h
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
      .get(),
  )
}

// Synchronous form for use inside db.transaction(): pass the tx so the row and its event are written atomically.
// The caller's transaction should be IMMEDIATE so the sequence read-then-write cannot race another writer.
export function appendEventSync(input: AppendEventInput, handle: DbHandle): EventRow {
  return insertEvent(handle, input)
}

export async function appendEvent(input: AppendEventInput, handle?: DbHandle): Promise<EventRow> {
  if (handle) return insertEvent(handle, input)
  // Read-max and insert share one IMMEDIATE transaction: the write lock is taken up front, so a second
  // connection waits (busy_timeout) rather than reading the same max under a shared lock and failing on
  // upgrade. The unique (runId, sequence) index is the backstop: a lost race throws rather than corrupts.
  return db.transaction(tx => insertEvent(tx, input), { behavior: 'immediate' })
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

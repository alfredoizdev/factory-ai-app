import { createHash } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { runs, workflows, workflowVersions } from '@/db/schema'
import { validateGraph, type Graph, type ValidationIssue } from '@/domain/graph'
import { appendEvent } from '@/engine/events'
import { strings } from '@/ui/strings'

// The boundary between designing and running. The draft is mutable; publishing freezes a version;
// a run binds to a frozen version and never reads the draft again.

// Every run in this milestone is simulated. The UI's Demo badge checks runs.providerId against this constant;
// import it rather than retyping the string.
export const DEMO_PROVIDER_ID = 'demo'

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`${strings.errors.workflowNotFound} (${id})`)
  }
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`${strings.errors.runNotFound} (${id})`)
  }
}

export class NothingPublishedError extends Error {
  constructor() {
    super(strings.errors.nothingPublished)
  }
}

export class PublishRefusedError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`${strings.errors.cannotPublish} ${issues.map(i => i.code).join(', ')}`)
  }
}

const now = () => new Date().toISOString()

function requireWorkflow(workflowId: string) {
  const wf = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
  if (!wf) throw new WorkflowNotFoundError(workflowId)
  return wf
}

// Keys sorted at every depth so the output is independent of property order.
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalise(v)]),
    )
  }
  return value
}

// Positions are presentation, not meaning: moving a block must not mint a new version.
export function hashGraph(graph: Graph): string {
  const meaningful = { blocks: graph.blocks.map(({ position: _position, ...rest }) => rest) }
  return createHash('sha256').update(JSON.stringify(canonicalise(meaningful))).digest('hex')
}

// An invalid draft is still saved (the user is mid-edit); the issues are returned so the canvas can show them.
export async function saveDraft(workflowId: string, graph: Graph): Promise<ValidationIssue[]> {
  requireWorkflow(workflowId)
  db.update(workflows)
    .set({ draftJson: JSON.stringify(graph), updatedAt: now() })
    .where(eq(workflows.id, workflowId))
    .run()
  return validateGraph(graph)
}

export async function publishVersion(workflowId: string): Promise<{ versionId: string; hash: string }> {
  return db.transaction(
    tx => {
      const wf = tx.select().from(workflows).where(eq(workflows.id, workflowId)).get()
      if (!wf) throw new WorkflowNotFoundError(workflowId)

      const graph = JSON.parse(wf.draftJson) as Graph
      const issues = validateGraph(graph)
      if (issues.length > 0) throw new PublishRefusedError(issues)

      const hash = hashGraph(graph)
      const latest = tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflowId))
        .orderBy(desc(sql`rowid`))
        .limit(1)
        .get()
      // Same meaning as the latest version: reuse it rather than minting a duplicate.
      if (latest && latest.hash === hash) return { versionId: latest.id, hash }

      const versionId = ulid()
      tx.insert(workflowVersions)
        .values({
          id: versionId,
          projectId: wf.projectId,
          workflowId,
          graphJson: JSON.stringify(graph),
          hash,
          createdAt: now(),
        })
        .run()
      return { versionId, hash }
    },
    { behavior: 'immediate' },
  )
}

export async function createRun(input: {
  workflowId: string
  request: string
}): Promise<{ runId: string; versionId: string }> {
  const wf = requireWorkflow(input.workflowId)
  // Latest published version only. The draft is never consulted.
  const version = db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, input.workflowId))
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get()
  if (!version) throw new NothingPublishedError()

  const runId = ulid()
  db.insert(runs)
    .values({
      id: runId,
      projectId: wf.projectId,
      workflowId: wf.id,
      versionId: version.id,
      status: 'queued',
      request: input.request,
      providerId: DEMO_PROVIDER_ID,
      createdAt: now(),
    })
    .run()
  await appendEvent({ runId, type: 'run.created', payload: { versionId: version.id } })
  return { runId, versionId: version.id }
}

// Persistence half only: marks the run cancelled so the durable execution function can observe it between steps.
// Nothing in flight is stopped here. A run that already finished is left as it is.
export async function cancelRun(runId: string): Promise<void> {
  const changed = db.transaction(
    tx => {
      const run = tx.select().from(runs).where(eq(runs.id, runId)).get()
      if (!run) throw new RunNotFoundError(runId)
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return false
      tx.update(runs).set({ status: 'cancelled', finishedAt: now() }).where(eq(runs.id, runId)).run()
      return true
    },
    { behavior: 'immediate' },
  )
  if (changed) await appendEvent({ runId, type: 'run.cancelled' })
}

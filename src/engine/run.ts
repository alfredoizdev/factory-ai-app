import { createHash } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { nodeRuns, runs, workflows, workflowVersions } from '@/db/schema'
import { STAGE_ORDER, validateGraph, type Graph, type ValidationIssue } from '@/domain/graph'
import { canTransition, type NodeState } from '@/domain/states'
import { appendEventSync } from '@/engine/events'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'

// The boundary between designing and running. The draft is mutable; publishing freezes a version;
// a run binds to a frozen version and never reads the draft again.

// Every run in this milestone is simulated. The UI's Demo badge checks runs.providerId against this constant;
// it is defined in a dependency-free module and re-exported here so existing imports keep working.
export { DEMO_PROVIDER_ID }

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
  // The run row and run.created commit together: a crash cannot leave a run with no events.
  db.transaction(
    tx => {
      tx.insert(runs)
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
      appendEventSync({ runId, type: 'run.created', payload: { versionId: version.id } }, tx)
      // Every block of the frozen version becomes a queued node run now (the design's section 7, step 2), so a block
      // a run never reaches can be ended as cancelled instead of reading "Queued" for ever.
      const graph = JSON.parse(version.graphJson) as Graph
      for (const kind of STAGE_ORDER) {
        for (const block of graph.blocks.filter(b => b.kind === kind)) {
          const row = tx
            .insert(nodeRuns)
            .values({ id: ulid(), projectId: wf.projectId, runId, blockId: block.id, state: 'queued', attempt: 1 })
            .returning()
            .get()
          appendEventSync({ runId, nodeRunId: row.id, type: 'node.queued', payload: { blockId: block.id } }, tx)
        }
      }
    },
    { behavior: 'immediate' },
  )
  return { runId, versionId: version.id }
}

// Persistence half only: marks the run cancelled so the durable execution function can observe it between steps
// and abort the in-flight provider. Every node that has not finished is cancelled with it, so a cancelled run never
// shows a node still running. The run row, node rows and their events commit in one transaction; a run that already
// finished is left as it is.
export async function cancelRun(runId: string): Promise<void> {
  db.transaction(
    tx => {
      const run = tx.select().from(runs).where(eq(runs.id, runId)).get()
      if (!run) throw new RunNotFoundError(runId)
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return
      const finishedAt = now()
      tx.update(runs).set({ status: 'cancelled', finishedAt }).where(eq(runs.id, runId)).run()
      for (const node of tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all()) {
        if (!canTransition(node.state as NodeState, 'cancelled')) continue
        tx.update(nodeRuns).set({ state: 'cancelled', finishedAt }).where(eq(nodeRuns.id, node.id)).run()
        appendEventSync({ runId, nodeRunId: node.id, type: 'node.cancelled', payload: { blockId: node.blockId } }, tx)
      }
      appendEventSync({ runId, type: 'run.cancelled' }, tx)
    },
    { behavior: 'immediate' },
  )
}

// For a run whose execution could not be requested: ends it as failed (status and event together) so it does not sit queued.
export async function failUnstartedRun(runId: string): Promise<void> {
  db.transaction(
    tx => {
      const run = tx.select().from(runs).where(eq(runs.id, runId)).get()
      if (!run || run.status !== 'queued') return
      tx.update(runs).set({ status: 'failed', finishedAt: now() }).where(eq(runs.id, runId)).run()
      // Nothing will ever run these blocks; leaving them queued would say they are still to come.
      for (const node of tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all()) {
        if (!canTransition(node.state as NodeState, 'cancelled')) continue
        tx.update(nodeRuns).set({ state: 'cancelled', finishedAt: now() }).where(eq(nodeRuns.id, node.id)).run()
        appendEventSync({ runId, nodeRunId: node.id, type: 'node.cancelled', payload: { blockId: node.blockId, reason: strings.run.couldNotStart } }, tx)
      }
      appendEventSync({ runId, type: 'run.failed', payload: { cause: 'not_started', message: strings.run.couldNotStart } }, tx)
    },
    { behavior: 'immediate' },
  )
}

import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, events, nodeRuns, runs, workflowVersions } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import type { DbHandle } from '@/engine/events'

/**
 * Who opened the human check: the person (an 'approved' approvals row) or the app (node.completed with
 * autoApproved: true on a human node, as passLowRiskGate writes it). A person's yes wins when both exist.
 */
export async function humanCheckPassedBy(runId: string, h: DbHandle = db): Promise<'person' | 'app' | null> {
  const approved = (await h.select().from(approvals).where(and(eq(approvals.runId, runId), eq(approvals.decision, 'approved'))))[0]
  if (approved) return 'person'
  const run = (await h.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return null
  const version = (await h.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]
  if (!version) return null
  const humanBlocks = (JSON.parse(version.graphJson) as Graph).blocks.filter(b => b.kind === 'human').map(b => b.id)
  if (humanBlocks.length === 0) return null
  const passed = new Set(
    (await h.select().from(nodeRuns).where(and(eq(nodeRuns.runId, runId), eq(nodeRuns.state, 'passed'))))
      .filter(n => humanBlocks.includes(n.blockId))
      .map(n => n.id),
  )
  const done = await h.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'node.completed')))
  const byApp = done.some(e => {
    if (!e.nodeRunId || !passed.has(e.nodeRunId)) return false
    try {
      return (JSON.parse(e.payloadJson) as { autoApproved?: unknown }).autoApproved === true
    } catch {
      return false
    }
  })
  return byApp ? 'app' : null
}

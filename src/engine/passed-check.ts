import { and, eq, inArray } from 'drizzle-orm'
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

/**
 * Of these runs, the ones the app passed at the human check on its own and no person approved, and that finished.
 * The same rule as humanCheckPassedBy, read for a whole list in a fixed number of queries.
 */
export async function passedOnItsOwnAmong(runIds: string[], h: DbHandle = db): Promise<Set<string>> {
  const out = new Set<string>()
  if (runIds.length === 0) return out
  const rows = await h.select({ id: runs.id, versionId: runs.versionId }).from(runs).where(and(inArray(runs.id, runIds), eq(runs.status, 'completed')))
  if (rows.length === 0) return out
  const ids = rows.map(r => r.id)
  const approved = new Set((await h.select({ runId: approvals.runId }).from(approvals).where(and(inArray(approvals.runId, ids), eq(approvals.decision, 'approved')))).map(a => a.runId))
  const humanOf = new Map<string, string[]>()
  for (const v of await h.select().from(workflowVersions).where(inArray(workflowVersions.id, [...new Set(rows.map(r => r.versionId))]))) {
    try {
      humanOf.set(v.id, (JSON.parse(v.graphJson) as Graph).blocks.filter(b => b.kind === 'human').map(b => b.id))
    } catch {
      humanOf.set(v.id, [])
    }
  }
  const versionOf = new Map(rows.map(r => [r.id, r.versionId]))
  const passed = new Map<string, string>()
  for (const n of await h.select().from(nodeRuns).where(and(inArray(nodeRuns.runId, ids), eq(nodeRuns.state, 'passed')))) {
    if (humanOf.get(versionOf.get(n.runId) ?? '')?.includes(n.blockId)) passed.set(n.id, n.runId)
  }
  if (passed.size === 0) return out
  for (const e of await h.select().from(events).where(and(inArray(events.runId, ids), eq(events.type, 'node.completed')))) {
    if (!e.nodeRunId || !passed.has(e.nodeRunId) || approved.has(e.runId)) continue
    try {
      if ((JSON.parse(e.payloadJson) as { autoApproved?: unknown }).autoApproved === true) out.add(e.runId)
    } catch {
      // An event that cannot be read does not count.
    }
  }
  return out
}

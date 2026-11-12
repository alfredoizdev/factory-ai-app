import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { nodeRuns, runs, workflowVersions } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { and } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { DeliveryError, keepCommit, unfinishedCommit, wasDelivered } from '@/engine/delivery'
import { appendEvent } from '@/engine/events'
import { humanCheckPassedBy } from '@/engine/passed-check'
import { runPlace } from '@/engine/machine'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { createRun, type RunProviderId } from '@/engine/run'
import { strings } from '@/ui/strings'

// Another change on top of an approved one. A finished run cannot be resumed, so a follow-up is a new run that starts
// from the approved change: it is committed on the parent's branch, and the new run's worktree starts from that commit.
// Its human check therefore shows only what is new, and bringing it over carries the parent along if the parent was
// never brought over itself.

export class FollowUpError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message)
    this.name = 'FollowUpError'
  }
}

export async function startFollowUp(parentRunId: string, note: string): Promise<{ runId: string }> {
  const text = note.trim()
  if (!text) throw new FollowUpError(strings.followUp.needNote, 400)
  const parent = (await db.select().from(runs).where(eq(runs.id, parentRunId)))[0]
  if (!parent) throw new FollowUpError(strings.errors.runNotFound, 404)
  // A run that failed is picked up where it stopped instead: see continueFailed.
  if (parent.status === 'failed') return continueFailed(parent, text)
  if (parent.status !== 'completed' || (await humanCheckPassedBy(parentRunId)) === null || !parent.worktreePath || !parent.baseCommit) {
    throw new FollowUpError(strings.followUp.notEligible, 409)
  }
  let parentCommit: string
  try {
    parentCommit = keepCommit(parent)
  } catch (e) {
    if (e instanceof DeliveryError) throw new FollowUpError(e.message, 409)
    throw new FollowUpError(strings.followUp.couldNotKeep, 409)
  }
  const { runId } = await createRun({ workflowId: parent.workflowId, request: text, providerId: parent.providerId as RunProviderId })
  await db.update(runs)
    .set({
      parentRunId,
      stopForMe: parent.stopForMe,
      // The new worktree starts here; its human check compares against it, so it shows only the new change.
      baseCommit: parentCommit,
      deliveryBase: (await wasDelivered(parentRunId)) ? null : (parent.deliveryBase ?? parent.baseCommit),
    })
    .where(eq(runs.id, runId))
    
  return { runId }
}

/**
 * Picks up a run that failed (a check that did not pass, an agent that stopped): a new run whose worktree starts
 * from what the failed one left, so the agents fix it instead of starting over. Nobody approved that work, so the
 * new run is compared against the commit the failed run started from: its human check shows the whole change.
 */
async function continueFailed(parent: typeof runs.$inferSelect, text: string): Promise<{ runId: string }> {
  const here = (await runPlace(parent.id)).here
  if (parent.providerId === DEMO_PROVIDER_ID || !here || !parent.baseCommit || !parent.worktreePath || !existsSync(parent.worktreePath)) {
    throw new FollowUpError(strings.failure.cannotContinue, 409)
  }
  let commit: string
  try {
    commit = unfinishedCommit(parent)
  } catch {
    throw new FollowUpError(strings.failure.cannotContinue, 409)
  }
  const { runId } = await createRun({ workflowId: parent.workflowId, request: text, providerId: parent.providerId as RunProviderId })
  await db.update(runs).set({ parentRunId: parent.id, stopForMe: parent.stopForMe, baseCommit: parent.baseCommit, deliveryBase: parent.deliveryBase, title: parent.title }).where(eq(runs.id, runId))
  await appendEvent({ runId, type: 'run.continues', payload: { fromRun: parent.id, commit, skipPlan: await planWasMade(parent) } })
  return { runId }
}

/** True when the failed run's plan was checked and built from: the run that picks it up does not plan again. */
async function planWasMade(parent: typeof runs.$inferSelect): Promise<boolean> {
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, parent.versionId)))[0]
  if (!version) return false
  const planBlocks = (JSON.parse(version.graphJson) as Graph).blocks.filter(b => b.kind === 'plan').map(b => b.id)
  const rows = await db.select().from(nodeRuns).where(and(eq(nodeRuns.runId, parent.id), eq(nodeRuns.state, 'passed')))
  return rows.some(r => planBlocks.includes(r.blockId))
}

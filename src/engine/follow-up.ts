import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, runs } from '@/db/schema'
import { and } from 'drizzle-orm'
import { DeliveryError, keepCommit, wasDelivered } from '@/engine/delivery'
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
  const parent = db.select().from(runs).where(eq(runs.id, parentRunId)).get()
  if (!parent) throw new FollowUpError(strings.errors.runNotFound, 404)
  const approved = db.select().from(approvals).where(and(eq(approvals.runId, parentRunId), eq(approvals.decision, 'approved'))).get()
  if (parent.status !== 'completed' || !approved || !parent.worktreePath || !parent.baseCommit) {
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
  db.update(runs)
    .set({
      parentRunId,
      // The new worktree starts here; its human check compares against it, so it shows only the new change.
      baseCommit: parentCommit,
      deliveryBase: wasDelivered(parentRunId) ? null : (parent.deliveryBase ?? parent.baseCommit),
    })
    .where(eq(runs.id, runId))
    .run()
  return { runId }
}

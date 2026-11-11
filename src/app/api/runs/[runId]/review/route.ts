import { changeUnderReview, NO_CHANGE } from '@/engine/approvals'

// What the person is asked to decide on: the run's change, redacted, with the hash a decision is bound to.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  try {
    return Response.json(changeUnderReview(runId) ?? { hash: NO_CHANGE, files: [], diff: '', truncated: false })
  } catch {
    return Response.json({ error: 'unreadable' }, { status: 500 })
  }
}

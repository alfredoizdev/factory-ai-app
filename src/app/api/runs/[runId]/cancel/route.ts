import { rejectCrossSite } from '@/engine/same-origin'
import { stopPreview } from '@/engine/preview'
import { cancelRun, RunNotFoundError } from '@/engine/run'

export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const { runId } = await ctx.params
  try {
    await cancelRun(runId)
    stopPreview(runId) // a cancelled run's preview has nothing left to show
    return Response.json({ runId, status: 'cancelled' })
  } catch (e) {
    if (e instanceof RunNotFoundError) return Response.json({ error: e.message }, { status: 404 })
    throw e
  }
}

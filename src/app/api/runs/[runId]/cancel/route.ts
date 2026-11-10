import { cancelRun, RunNotFoundError } from '@/engine/run'

export async function POST(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  try {
    await cancelRun(runId)
    return Response.json({ runId, status: 'cancelled' })
  } catch (e) {
    if (e instanceof RunNotFoundError) return Response.json({ error: e.message }, { status: 404 })
    throw e
  }
}

import { explainFailure } from '@/engine/failure-explain'
import { requireOwnPage } from '@/engine/same-origin'

// The failure in plain words, written by a small model. It costs a model call, so only the app's own page may ask.
export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  return Response.json({ explanation: await explainFailure(runId) })
}

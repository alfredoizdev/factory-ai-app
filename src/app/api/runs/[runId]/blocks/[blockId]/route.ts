import { blockDetails } from '@/engine/block-details'
import { strings } from '@/ui/strings'

// Everything recorded about one block of a run: read-only, for the "See details" window.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string; blockId: string }> }) {
  const { runId, blockId } = await ctx.params
  const details = await blockDetails(runId, blockId)
  if (!details) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })
  return Response.json(details)
}

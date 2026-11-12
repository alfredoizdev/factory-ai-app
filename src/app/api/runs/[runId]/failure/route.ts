import { runFailure } from '@/engine/failure'
import { strings } from '@/ui/strings'

// What failed in a run and why: read-only, for the "What went wrong" window.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  const failure = await runFailure(runId)
  if (!failure) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })
  return Response.json(failure)
}

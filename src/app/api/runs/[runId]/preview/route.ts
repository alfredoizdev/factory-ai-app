import { previewState, PreviewError, startPreview, stopPreview } from '@/engine/preview'
import { requireOwnPage } from '@/engine/same-origin'

type Ctx = { params: Promise<{ runId: string }> }

export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params
  return Response.json(previewState(runId))
}

// Starting one runs the project's dev script on this computer, so only the app's own page may ask for it.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  try {
    return Response.json(await startPreview(runId))
  } catch (e) {
    if (e instanceof PreviewError) return Response.json({ error: e.message }, { status: 409 })
    throw e
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  stopPreview(runId)
  return Response.json(previewState(runId))
}

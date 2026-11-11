import { deliverToProject, DeliveryError, deliveryState } from '@/engine/delivery'
import { requireOwnPage } from '@/engine/same-origin'

type Ctx = { params: Promise<{ runId: string }> }

function failed(e: unknown): Response {
  if (e instanceof DeliveryError) return Response.json({ error: e.message }, { status: e.status })
  throw e
}

export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params
  try {
    return Response.json(deliveryState(runId))
  } catch (e) {
    return failed(e)
  }
}

// Writes into the person's own project folder, so only the app's own page may ask for it.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  try {
    return Response.json(deliverToProject(runId))
  } catch (e) {
    return failed(e)
  }
}

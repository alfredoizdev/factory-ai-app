import { requireOwnPage } from '@/engine/same-origin'
import { captureBeforeAfter, SnapshotError, snapshotState } from '@/engine/snapshots'

type Ctx = { params: Promise<{ runId: string }> }

// Where the before and after pictures of this run's change stand. Reading only.
export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params
  return Response.json((await snapshotState(runId)))
}

// Takes them: starts the person's site twice on this computer and photographs it, so only the app's own page may ask.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  try {
    return Response.json((await captureBeforeAfter(runId)))
  } catch (e) {
    if (e instanceof SnapshotError) return Response.json({ error: e.message }, { status: 409 })
    throw e
  }
}

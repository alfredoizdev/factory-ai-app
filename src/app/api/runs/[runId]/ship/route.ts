import { z } from 'zod'
import { mergePullRequest, openPullRequest, ShipError, shipState } from '@/engine/ship'
import { requireOwnPage } from '@/engine/same-origin'

type Ctx = { params: Promise<{ runId: string }> }

function failed(e: unknown): Response {
  if (e instanceof ShipError) return Response.json({ error: e.message }, { status: e.status })
  throw e
}

// Where shipping stands: the pull request, its checks, and what reported after the merge. Reading only.
export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params
  try {
    return Response.json(await shipState(runId))
  } catch (e) {
    return failed(e)
  }
}

// 'open': push and open the pull request. 'merge': squash-merge it into main, which can put it live. Both act on
// GitHub with the person's own login, so only the app's own page may ask.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  const body = z.object({ action: z.enum(['open', 'merge']) }).safeParse(await req.json().catch(() => ({})))
  if (!body.success) return Response.json({ error: 'Say open or merge.' }, { status: 400 })
  try {
    return Response.json(body.data.action === 'open' ? await openPullRequest(runId) : await mergePullRequest(runId))
  } catch (e) {
    return failed(e)
  }
}

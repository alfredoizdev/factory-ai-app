import { z } from 'zod'
import { mergePullRequest, openPullRequest, setHold, ShipError, shipState } from '@/engine/ship'
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

// 'open': push and open the pull request. 'merge': squash-merge it into main, which can put it live. 'hold' / 'unhold':
// keep a ready pull request waiting, or stop waiting. All act for the person, so only the app's own page may ask.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  const body = z.object({ action: z.enum(['open', 'merge', 'hold', 'unhold']) }).safeParse(await req.json().catch(() => ({})))
  if (!body.success) return Response.json({ error: 'Say open, merge, hold or unhold.' }, { status: 400 })
  try {
    const action = body.data.action
    if (action === 'open') return Response.json(await openPullRequest(runId))
    if (action === 'merge') return Response.json(await mergePullRequest(runId))
    return Response.json(await setHold(runId, action === 'hold'))
  } catch (e) {
    return failed(e)
  }
}

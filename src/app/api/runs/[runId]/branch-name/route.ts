import { branchFromWords, suggestBranchWords } from '@/engine/branch-name'
import { changedFiles, deliveryState, DeliveryError, requestOf } from '@/engine/delivery'

type Ctx = { params: Promise<{ runId: string }> }

// A suggested name for the branch an approved change will be kept on, for the person to accept or change.
// Reading only: nothing is created until they press Keep.
export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params
  const request = (await requestOf(runId))
  if (request === null) return Response.json({ error: 'Run not found' }, { status: 404 })
  try {
    const state = (await deliveryState(runId))
    if (state.kept) return Response.json({ name: state.branch })
  } catch (e) {
    if (e instanceof DeliveryError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
  return Response.json({ name: branchFromWords(runId, await suggestBranchWords(request, (await changedFiles(runId)))) })
}

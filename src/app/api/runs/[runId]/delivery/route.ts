import { z } from 'zod'
import { branchFromWords, suggestBranchWords, suggestCommitMessage } from '@/engine/branch-name'
import { changedFiles, deliverToProject, DeliveryError, deliveryState, keepOnBranch, pendingDiff, pushBranch, requestOf, switchBack, switchToBranch } from '@/engine/delivery'
import { requireOwnPage } from '@/engine/same-origin'

type Ctx = { params: Promise<{ runId: string }> }

function failed(e: unknown): Response {
  if (e instanceof DeliveryError) return Response.json({ error: e.message }, { status: e.status })
  throw e
}

export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params
  try {
    return Response.json((await deliveryState(runId)))
  } catch (e) {
    return failed(e)
  }
}

// Writes into the person's own repository, so only the app's own page may ask for it.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  // 'branch': commit it on its own branch only. 'apply': also put it, uncommitted, into the current checkout.
  // 'switch': move the project onto the kept branch. 'back': return it to the branch it was on before.
  // 'push': send the kept branch, only that one, to origin.
  // `name`: the branch name the person chose; without one, a short model names it from what changed.
  const body = z
    .object({ mode: z.enum(['branch', 'apply', 'switch', 'back', 'push']).default('apply'), name: z.string().max(200).optional() })
    .safeParse(await req.json().catch(() => ({})))
  const mode = body.success ? body.data.mode : 'apply'
  const name = body.success ? (body.data.name?.trim() ?? '') : ''
  try {
    if (mode === 'switch') return Response.json((await switchToBranch(runId)))
    if (mode === 'back') return Response.json((await switchBack(runId)))
    if (mode === 'push') return Response.json(await pushBranch(runId))
    // Before the first keep, a short model names the branch (unless the person did) and describes the change, at once.
    const first = !(await deliveryState(runId)).kept
    const request = (await requestOf(runId)) ?? ''
    const [fallbackName, message] = first
      ? await Promise.all([name === '' ? suggestedName(runId) : null, suggestCommitMessage(request, (await pendingDiff(runId)))])
      : [null, null]
    const options = { name: name || null, fallbackName, message }
    return Response.json(mode === 'branch' ? (await keepOnBranch(runId, options)) : (await deliverToProject(runId, options)))
  } catch (e) {
    return failed(e)
  }
}

async function suggestedName(runId: string): Promise<string | null> {
  const request = (await requestOf(runId))
  return request === null ? null : branchFromWords(runId, await suggestBranchWords(request, (await changedFiles(runId))))
}

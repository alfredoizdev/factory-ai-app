import { z } from 'zod'
import { branchFromWords, suggestBranchWords } from '@/engine/branch-name'
import { changedFiles, deliverToProject, DeliveryError, deliveryState, keepOnBranch, requestOf, switchBack, switchToBranch } from '@/engine/delivery'
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

// Writes into the person's own repository, so only the app's own page may ask for it.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  // 'branch': commit it on its own branch only. 'apply': also put it, uncommitted, into the current checkout.
  // 'switch': move the project onto the kept branch. 'back': return it to the branch it was on before.
  // `name`: the branch name the person chose; without one, a short model names it from what changed.
  const body = z
    .object({ mode: z.enum(['branch', 'apply', 'switch', 'back']).default('apply'), name: z.string().max(200).optional() })
    .safeParse(await req.json().catch(() => ({})))
  const mode = body.success ? body.data.mode : 'apply'
  const name = body.success ? (body.data.name?.trim() ?? '') : ''
  try {
    if (mode === 'switch') return Response.json(switchToBranch(runId))
    if (mode === 'back') return Response.json(switchBack(runId))
    const fallbackName = name === '' && !deliveryState(runId).kept ? await suggestedName(runId) : null
    const options = { name: name || null, fallbackName }
    return Response.json(mode === 'branch' ? keepOnBranch(runId, options) : deliverToProject(runId, options))
  } catch (e) {
    return failed(e)
  }
}

async function suggestedName(runId: string): Promise<string | null> {
  const request = requestOf(runId)
  return request === null ? null : branchFromWords(runId, await suggestBranchWords(request, changedFiles(runId)))
}

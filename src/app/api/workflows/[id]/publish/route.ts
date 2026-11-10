import { rejectCrossSite } from '@/engine/same-origin'
import { publishVersion, PublishRefusedError, WorkflowNotFoundError } from '@/engine/run'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const { id } = await ctx.params
  try {
    return Response.json(await publishVersion(id), { status: 201 })
  } catch (e) {
    if (e instanceof PublishRefusedError) return Response.json({ error: e.message, issues: e.issues }, { status: 400 })
    if (e instanceof WorkflowNotFoundError) return Response.json({ error: e.message }, { status: 404 })
    throw e
  }
}

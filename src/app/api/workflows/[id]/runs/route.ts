import { z } from 'zod'
import { createRun, NothingPublishedError, WorkflowNotFoundError } from '@/engine/run'
import { strings } from '@/ui/strings'

const bodySchema = z.object({ request: z.string().trim().min(1) })

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    return Response.json(await createRun({ workflowId: id, request: body.data.request }), { status: 201 })
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) return Response.json({ error: e.message }, { status: 404 })
    if (e instanceof NothingPublishedError) return Response.json({ error: e.message }, { status: 409 })
    throw e
  }
}

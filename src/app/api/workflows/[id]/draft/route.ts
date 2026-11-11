import { z } from 'zod'
import { rejectCrossSite } from '@/engine/same-origin'
import { DraftConflictError, saveDraftVersioned, WorkflowNotFoundError } from '@/engine/run'
import { strings } from '@/ui/strings'

const graphSchema = z.object({
  blocks: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(['input', 'plan', 'build', 'tests', 'review', 'approve', 'human', 'ship']),
      label: z.string(),
      enabled: z.boolean(),
      config: z.record(z.string(), z.unknown()),
      position: z.object({ x: z.number(), y: z.number() }),
    }),
  ),
})

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const { id } = await ctx.params
  const body = graphSchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    // An invalid-but-well-formed graph is saved; the issues ride along for the canvas to render inline.
    // x-draft-base: the version the page last saw. Without it the save is unconditional, as before.
    const base = req.headers.get('x-draft-base') ?? undefined
    return Response.json(await saveDraftVersioned(id, body.data, base))
  } catch (e) {
    if (e instanceof DraftConflictError) return Response.json({ error: strings.editing.staleDraft }, { status: 409 })
    if (e instanceof WorkflowNotFoundError) return Response.json({ error: e.message }, { status: 404 })
    throw e
  }
}

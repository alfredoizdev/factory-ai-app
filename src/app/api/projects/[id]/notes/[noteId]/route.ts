import { deleteNote, updateNote } from '@/engine/memory'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

type Ctx = { params: Promise<{ id: string; noteId: string }> }

// Rewords a rule, or switches it off or on. Only from the app's own page.
export async function PATCH(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { id, noteId } = await ctx.params
  const body = (await req.json().catch(() => null)) as { text?: unknown; enabled?: unknown } | null
  const note = updateNote(id, noteId, {
    ...(typeof body?.text === 'string' ? { text: body.text.slice(0, 2000) } : {}),
    ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
  })
  if (!note) return Response.json({ error: strings.memory.empty }, { status: 400 })
  return Response.json({ note })
}

// Forgets a rule. Only from the app's own page.
export async function DELETE(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { id, noteId } = await ctx.params
  return deleteNote(id, noteId) ? new Response(null, { status: 204 }) : Response.json({ error: strings.memory.notFound }, { status: 404 })
}

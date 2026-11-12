import { deleteNote, updateNote } from '@/engine/memory'
import { CoreError } from '@/engine/register'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

type Ctx = { params: Promise<{ id: string; noteId: string }> }

// Rewords a rule, decision or core area, switches it off or on, or moves a core area. Only from the app's own page.
export async function PATCH(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { id, noteId } = await ctx.params
  const body = (await req.json().catch(() => null)) as { text?: unknown; enabled?: unknown; path?: unknown } | null
  let note
  try {
    note = await updateNote(id, noteId, {
      ...(typeof body?.text === 'string' ? { text: body.text.slice(0, 2000) } : {}),
      ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body?.path === 'string' ? { path: body.path.slice(0, 500) } : {}),
    })
  } catch (e) {
    if (e instanceof CoreError) return Response.json({ error: e.message }, { status: 400 })
    throw e
  }
  if (!note) return Response.json({ error: strings.memory.empty }, { status: 400 })
  return Response.json({ note })
}

// Forgets a rule. Only from the app's own page.
export async function DELETE(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { id, noteId } = await ctx.params
  return (await deleteNote(id, noteId)) ? new Response(null, { status: 204 }) : Response.json({ error: strings.memory.notFound }, { status: 404 })
}

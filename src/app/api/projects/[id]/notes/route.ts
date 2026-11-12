import { addNote, listNotes } from '@/engine/memory'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

type Ctx = { params: Promise<{ id: string }> }

// The project's memory: the rules its tasks start with. Reading only.
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  return Response.json({ notes: (await listNotes(id)) })
}

// A rule written by hand. Only from the app's own page.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { id } = await ctx.params
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null
  const note = typeof body?.text === 'string' ? (await addNote(id, body.text.slice(0, 2000))) : null
  if (!note) return Response.json({ error: strings.memory.empty }, { status: 400 })
  return Response.json({ note }, { status: 201 })
}

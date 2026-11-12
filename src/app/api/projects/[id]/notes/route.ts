import { addNote, listNotes } from '@/engine/memory'
import { addCoreArea, candidatesFor, CoreError, listRegister } from '@/engine/register'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

type Ctx = { params: Promise<{ id: string }> }

// The project's memory. `notes` are the rules its tasks start with; `entries` is the whole register (rules, decisions,
// core areas and the log of what reviewers found), numbered; `candidates` are areas the latest change touched that the
// person may want to mark as core. Reading only.
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  return Response.json({ notes: await listNotes(id), entries: await listRegister(id), candidates: await candidatesFor(id) })
}

// A rule written by hand, or a core area (typed, or a suggestion the person confirmed). Only from the app's own page.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { id } = await ctx.params
  const body = (await req.json().catch(() => null)) as { kind?: unknown; text?: unknown; path?: unknown; paths?: unknown; area?: unknown } | null
  if (body?.kind === 'core') {
    const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string').slice(0, 50) : undefined
    try {
      const note = await addCoreArea(id, {
        ...(typeof body.path === 'string' ? { path: body.path.slice(0, 500) } : {}),
        ...(paths ? { paths: paths.map(p => p.slice(0, 500)) } : {}),
        ...(typeof body.area === 'string' ? { area: body.area.slice(0, 100) } : {}),
      })
      return Response.json({ note }, { status: 201 })
    } catch (e) {
      if (e instanceof CoreError) return Response.json({ error: e.message }, { status: 400 })
      throw e
    }
  }
  const note = typeof body?.text === 'string' ? (await addNote(id, body.text.slice(0, 2000))) : null
  if (!note) return Response.json({ error: strings.memory.empty }, { status: 400 })
  return Response.json({ note }, { status: 201 })
}

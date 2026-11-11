import { prepareBase } from '@/engine/base'
import { rejectCrossSite } from '@/engine/same-origin'

// (Re)prepares the project's base in the background: its main branch with the dependencies installed once.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const { id } = await ctx.params
  void prepareBase(id)
  return Response.json({ started: true }, { status: 202 })
}

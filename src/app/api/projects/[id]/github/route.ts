import { z } from 'zod'
import { ConnectError, connectProjectGithub, projectGithub } from '@/engine/github-connect'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

const bodySchema = z.union([z.object({ create: z.enum(['private', 'public']) }), z.object({ url: z.string().max(300) })])

// Where the project is on GitHub, for its settings.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return Response.json(await projectGithub(id))
}

// Connects the project to GitHub: creates a repository or adds a remote, and uploads. Only the app's own page may ask.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { id } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    return Response.json(await connectProjectGithub(id, body.data))
  } catch (e) {
    if (e instanceof ConnectError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}

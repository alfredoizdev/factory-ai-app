import { z } from 'zod'
import { getProjectSettings, ProjectSettingsError, setAutoApproveLowRisk, setProjectName, setProjectRepo, setTestCommand } from '@/engine/project-settings'
import { rejectCrossSite } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

const bodySchema = z.object({
  repoPath: z.string().min(1).optional(),
  testCommand: z.string().nullable().optional(),
  autoApproveLowRisk: z.boolean().optional(),
  name: z.string().max(200).optional(),
})

function settingsError(e: unknown): Response {
  if (e instanceof ProjectSettingsError) return Response.json({ error: e.message }, { status: 400 })
  throw e
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    return Response.json((await getProjectSettings(id)))
  } catch (e) {
    return settingsError(e)
  }
}

// The repository decides where an unattended agent works, so this route is guarded like every other mutating one.
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const { id } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    // The command first, so a repository set in the same request keeps the command the person typed.
    if (body.data.testCommand !== undefined) (await setTestCommand(id, body.data.testCommand))
    if (body.data.repoPath !== undefined) (await setProjectRepo(id, body.data.repoPath))
    if (body.data.autoApproveLowRisk !== undefined) (await setAutoApproveLowRisk(id, body.data.autoApproveLowRisk))
    if (body.data.name !== undefined) (await setProjectName(id, body.data.name))
    return Response.json((await getProjectSettings(id)))
  } catch (e) {
    return settingsError(e)
  }
}

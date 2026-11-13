import { z } from 'zod'
import { ASK_MODES } from '@/domain/ask-mode'
import { MODEL_CHOICES } from '@/domain/models'
import { cleanStack, stackNames } from '@/domain/stack'
import { prepareBase } from '@/engine/base'
import { ProjectSettingsError } from '@/engine/project-settings'
import { createProject } from '@/engine/projects'
import { rejectCrossSite } from '@/engine/same-origin'
import { startFromScratch } from '@/engine/scratch'
import { strings } from '@/ui/strings'

export const dynamic = 'force-dynamic'

const schema = z.object({
  path: z.string().min(1).max(1000),
  name: z.string().min(1).max(200),
  githubUrl: z.string().max(300).nullable().optional(),
  stack: z.object({ frontEnd: z.string().max(40).nullable(), backEnds: z.array(z.string().max(40)).max(10) }).optional(),
  addTests: z.boolean(),
  askMode: z.enum(ASK_MODES).optional(),
  models: z.object({ plan: z.enum(MODEL_CHOICES), build: z.enum(MODEL_CHOICES), review: z.enum(MODEL_CHOICES) }).partial().optional(),
})

// A project from scratch: makes the folder an empty repository, adds it as a project with what was chosen kept as
// standing rules, and hands back the text of its first task. The agents build the project; nothing is sent anywhere.
export async function POST(req: Request) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const body = schema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  const { name, addTests, askMode, models } = body.data
  const names = stackNames(cleanStack(body.data.stack))
  let path: string
  try {
    path = startFromScratch({ path: body.data.path, name, githubUrl: body.data.githubUrl })
  } catch (e) {
    if (e instanceof ProjectSettingsError) return Response.json({ error: e.message }, { status: 400 })
    throw e
  }
  try {
    const rules = [...(names.length > 0 ? [strings.wizard.rules.builtWith(names)] : []), ...(addTests ? [strings.wizard.rules.tests] : [])]
    const created = await createProject({ path, name, testCommand: null, checks: [], askMode, models, rules })
    void prepareBase(created.projectId)
    return Response.json({ ...created, firstTask: strings.wizard.firstTask(name.trim(), names, addTests) }, { status: 201 })
  } catch (e) {
    // The folder exists now: the person is told, so they can add it the other way instead of hitting "not empty".
    if (e instanceof ProjectSettingsError) return Response.json({ error: `${e.message} ${strings.wizard.errors.createdButFailed(path)}` }, { status: 400 })
    throw e
  }
}

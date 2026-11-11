import { z } from 'zod'
import { prepareBase } from '@/engine/base'
import { ProjectSettingsError } from '@/engine/project-settings'
import { createProject, listProjects } from '@/engine/projects'
import { rejectCrossSite } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

export const dynamic = 'force-dynamic'

// Every project, with its flow and the state of its prepared base. Reading only.
export async function GET() {
  return Response.json({ projects: listProjects() })
}

const createSchema = z.object({
  path: z.string().min(1).max(1000),
  name: z.string().max(200),
  testCommand: z.string().max(500).nullable(),
  checks: z.array(z.object({ label: z.string().max(200), command: z.string().max(500) })).max(10),
  autoApproveLowRisk: z.boolean().optional(),
})

// Makes a folder a project, then prepares its base in the background (installing its dependencies once).
export async function POST(req: Request) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const body = createSchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    const created = await createProject(body.data)
    void prepareBase(created.projectId)
    return Response.json(created, { status: 201 })
  } catch (e) {
    if (e instanceof ProjectSettingsError) return Response.json({ error: e.message }, { status: 400 })
    throw e
  }
}

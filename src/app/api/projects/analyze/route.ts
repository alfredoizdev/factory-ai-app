import { z } from 'zod'
import { ProjectSettingsError } from '@/engine/project-settings'
import { analyzeProject } from '@/engine/project-setup'
import { rejectCrossSite } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

// Reads a folder for the setup screen: nothing is created or installed. POST, so a page elsewhere cannot probe paths.
export async function POST(req: Request) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const body = z.object({ path: z.string().min(1).max(1000) }).safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    return Response.json(await analyzeProject(body.data.path))
  } catch (e) {
    if (e instanceof ProjectSettingsError) return Response.json({ error: e.message }, { status: 400 })
    throw e
  }
}

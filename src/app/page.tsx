import { redirect } from 'next/navigation'
import { listProjects } from '@/engine/projects'
import { DEMO_WORKFLOW_ID, removeUnusedDemoProject } from '@/db/seed'
import { DbDown, isDbFailure } from '@/ui/DbDown'
import { Welcome } from '@/ui/Welcome'

export const dynamic = 'force-dynamic'

// The app opens on the first project. With none yet, it opens on a welcome screen whose one button starts the
// "New project" wizard. The example project older versions created is not a project to open: it is skipped, and
// removed when no task was ever run in it.
export default async function Home() {
  let target: string | undefined
  try {
    target = (await listProjects()).find(p => p.workflowId !== DEMO_WORKFLOW_ID)?.workflowId
    if (!target) await removeUnusedDemoProject()
  } catch (e) {
    if (isDbFailure(e)) return <DbDown />
    throw e
  }
  if (!target) return <Welcome />
  redirect(`/canvas/${target}`)
}

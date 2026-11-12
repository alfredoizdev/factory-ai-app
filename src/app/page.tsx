import { redirect } from 'next/navigation'
import { listProjects } from '@/engine/projects'
import { DEMO_WORKFLOW_ID, seedDemoProject } from '@/db/seed'
import { DbDown, isDbFailure } from '@/ui/DbDown'

export const dynamic = 'force-dynamic'

// The app opens on the first project, or on the demo when there is none yet; projects are added from the canvas.
export default async function Home() {
  let target: string
  try {
    const first = (await listProjects())[0]
    // An empty database (a fresh Neon project) gets the demo flow, so there is always something to open.
    if (!first) await seedDemoProject()
    target = first?.workflowId ?? DEMO_WORKFLOW_ID
  } catch (e) {
    if (isDbFailure(e)) return <DbDown />
    throw e
  }
  redirect(`/canvas/${target}`)
}

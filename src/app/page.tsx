import { redirect } from 'next/navigation'
import { listProjects } from '@/engine/projects'
import { DEMO_WORKFLOW_ID } from '@/db/seed'

export const dynamic = 'force-dynamic'

// The app opens on the first project, or on the demo when there is none yet; projects are added from the canvas.
export default async function Home() {
  const first = (await listProjects())[0]
  redirect(`/canvas/${first?.workflowId ?? DEMO_WORKFLOW_ID}`)
}

import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { workflows } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { CanvasScreen } from '@/ui/canvas/CanvasScreen'

export const dynamic = 'force-dynamic'

export default async function CanvasPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params
  const wf = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
  if (!wf) notFound()

  const graph = JSON.parse(wf.draftJson) as Graph

  return <CanvasScreen workflowId={workflowId} graph={graph} />
}

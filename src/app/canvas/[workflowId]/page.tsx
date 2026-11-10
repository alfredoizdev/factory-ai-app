import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { workflows } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { summarize } from '@/domain/summary'
import { CanvasScreen } from '@/ui/canvas/CanvasScreen'
import type { NodeRunView } from '@/ui/canvas/BlockCard'

export const dynamic = 'force-dynamic'

export default async function CanvasPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params
  const wf = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
  if (!wf) notFound()

  const graph = JSON.parse(wf.draftJson) as Graph

  // No run exists yet: every block is honestly queued, with its own plain-language line.
  const nodeRuns: NodeRunView[] = graph.blocks.map(block => ({
    blockId: block.id,
    state: 'queued',
    summary: summarize({ kind: block.kind, state: 'queued' }),
    summaryIsClaim: false,
    steps: [],
  }))

  return <CanvasScreen graph={graph} nodeRuns={nodeRuns} />
}

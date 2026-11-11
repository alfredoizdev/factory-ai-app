import { notFound } from 'next/navigation'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects, runs, workflowVersions, workflows } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { CanvasScreen, type RunInfo } from '@/ui/canvas/CanvasScreen'

export const dynamic = 'force-dynamic'

export default async function CanvasPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params
  const wf = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
  if (!wf) notFound()

  const graph = JSON.parse(wf.draftJson) as Graph

  // Open on the latest run, if there is one, so reloading the page does not lose sight of it.
  const latest = db.select().from(runs).where(eq(runs.workflowId, workflowId)).orderBy(desc(sql`rowid`)).limit(1).get()
  const version = latest ? db.select().from(workflowVersions).where(eq(workflowVersions.id, latest.versionId)).get() : undefined
  const run: RunInfo | null =
    latest && version
      ? { runId: latest.id, providerId: latest.providerId, blocks: (JSON.parse(version.graphJson) as Graph).blocks }
      : null

  const project = db.select().from(projects).where(eq(projects.id, wf.projectId)).get()
  const settings = {
    projectId: wf.projectId,
    repoPath: project?.repoPath ?? null,
    testCommand: project?.testCommand ?? null,
    autoApproveLowRisk: project?.autoApproveLowRisk ?? false,
  }

  return <CanvasScreen workflowId={workflowId} graph={graph} run={run} settings={settings} />
}

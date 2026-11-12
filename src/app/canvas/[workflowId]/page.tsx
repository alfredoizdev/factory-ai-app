import { getProjectSettings } from '@/engine/project-settings'
import { notFound } from 'next/navigation'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs, workflowVersions, workflows } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { CanvasScreen, type RunInfo } from '@/ui/canvas/CanvasScreen'
import { projectHere, runPlace } from '@/engine/machine'
import { DbDown, isDbFailure } from '@/ui/DbDown'

export const dynamic = 'force-dynamic'

export default async function CanvasPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params
  try {
    return await canvasFor(workflowId)
  } catch (e) {
    // The database could not be reached: said so, instead of an empty canvas or an error page.
    if (isDbFailure(e)) return <DbDown />
    throw e
  }
}

async function canvasFor(workflowId: string) {
  const wf = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0]
  if (!wf) notFound()

  const graph = JSON.parse(wf.draftJson) as Graph

  // Open on the latest run, if there is one, so reloading the page does not lose sight of it.
  const latest = (await db.select().from(runs).where(eq(runs.workflowId, workflowId)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1))[0]
  const version = latest ? (await db.select().from(workflowVersions).where(eq(workflowVersions.id, latest.versionId)))[0] : undefined
  const run: RunInfo | null =
    latest && version
      ? { runId: latest.id, providerId: latest.providerId, title: latest.title ?? undefined, ...(await runPlace(latest.id)), blocks: (JSON.parse(version.graphJson) as Graph).blocks }
      : null

  const project = await projectHere(wf.projectId)
  const settings = project ? (await getProjectSettings(project.id)) : { projectId: wf.projectId, repoPath: null, testCommand: null, autoApproveLowRisk: false, currentBranch: null, defaultBranch: null }

  return <CanvasScreen workflowId={workflowId} graph={graph} run={run} settings={settings} draftUpdatedAt={wf.updatedAt} />
}

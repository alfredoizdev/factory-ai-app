import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs, workflowVersions } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { deleteRun, RunDeleteError } from '@/engine/run-delete'
import { requireOwnPage } from '@/engine/same-origin'
import { setRunTitle, titleOf } from '@/engine/title'
import { runPlace } from '@/engine/machine'
import { strings } from '@/ui/strings'

export const dynamic = 'force-dynamic'

// What the canvas needs to watch a run: who is running it and the frozen blocks it executes.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]
  if (!version) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })
  const place = await runPlace(run.id)
  return Response.json({ runId: run.id, providerId: run.providerId, title: titleOf(run), here: place.here, machine: place.machine, blocks: (JSON.parse(version.graphJson) as Graph).blocks })
}

// Renames the task. Only from the app's own page.
export async function PATCH(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  const body = (await req.json().catch(() => null)) as { title?: unknown } | null
  const title = typeof body?.title === 'string' ? (await setRunTitle(runId, body.title.slice(0, 400))) : null
  if (!title) return Response.json({ error: strings.title.empty }, { status: 400 })
  return Response.json({ title })
}

// Deletes the task: removes what the app keeps about it from the person's computer, so only the app's own page may ask.
export async function DELETE(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  try {
    await deleteRun(runId)
    return new Response(null, { status: 204 })
  } catch (e) {
    if (e instanceof RunDeleteError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}

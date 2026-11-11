import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs, workflowVersions } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { deleteRun, RunDeleteError } from '@/engine/run-delete'
import { requireOwnPage } from '@/engine/same-origin'
import { setRunTitle, titleOf } from '@/engine/title'
import { strings } from '@/ui/strings'

export const dynamic = 'force-dynamic'

// What the canvas needs to watch a run: who is running it and the frozen blocks it executes.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })
  const version = db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)).get()
  if (!version) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })
  return Response.json({ runId: run.id, providerId: run.providerId, title: titleOf(run), blocks: (JSON.parse(version.graphJson) as Graph).blocks })
}

// Renames the task. Only from the app's own page.
export async function PATCH(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  const body = (await req.json().catch(() => null)) as { title?: unknown } | null
  const title = typeof body?.title === 'string' ? setRunTitle(runId, body.title.slice(0, 400)) : null
  if (!title) return Response.json({ error: strings.title.empty }, { status: 400 })
  return Response.json({ title })
}

// Deletes the task: removes what the app keeps about it from the person's computer, so only the app's own page may ask.
export async function DELETE(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  try {
    deleteRun(runId)
    return new Response(null, { status: 204 })
  } catch (e) {
    if (e instanceof RunDeleteError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}

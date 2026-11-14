import { rejectCrossSite } from '@/engine/same-origin'
import { z } from 'zod'
import { claimAttachments, MAX_IMAGES } from '@/engine/attachments'
import { inngest, RUN_REQUESTED } from '@/engine/inngest/client'
import { createRun, failUnstartedRun, listRuns, NothingPublishedError, RepoNotSetError, StartBranchError, WorkflowNotFoundError } from '@/engine/run'
import { strings } from '@/ui/strings'

const bodySchema = z.object({
  request: z.string().trim().min(1),
  provider: z.enum(['demo', 'claude']).optional(),
  attachments: z.array(z.string()).max(MAX_IMAGES).optional(),
  startFrom: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  stopForMe: z.boolean().optional(),
  direct: z.boolean().optional(),
})

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  const { id } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    const created = await createRun({ workflowId: id, request: body.data.request, providerId: body.data.provider, startFrom: body.data.startFrom, title: body.data.title, stopForMe: body.data.stopForMe, direct: body.data.direct })
    await claimAttachments(body.data.attachments ?? [], created.runId)
    try {
      await inngest.send({ name: RUN_REQUESTED, data: { runId: created.runId } })
    } catch {
      // Nothing will ever execute this run, so say so rather than leave it queued forever.
      await failUnstartedRun(created.runId)
      return Response.json({ error: strings.run.couldNotStart, runId: created.runId }, { status: 503 })
    }
    return Response.json(created, { status: 201 })
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) return Response.json({ error: e.message }, { status: 404 })
    if (e instanceof NothingPublishedError) return Response.json({ error: e.message }, { status: 409 })
    if (e instanceof RepoNotSetError) return Response.json({ error: e.message }, { status: 409 })
    if (e instanceof StartBranchError) return Response.json({ error: e.message }, { status: 409 })
    throw e
  }
}

// The past tasks of this flow, for the sidebar's list. Reading only.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return Response.json({ runs: (await listRuns(id)) })
}

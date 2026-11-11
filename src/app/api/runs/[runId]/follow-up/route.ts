import { z } from 'zod'
import { FollowUpError, startFollowUp } from '@/engine/follow-up'
import { inngest, RUN_REQUESTED } from '@/engine/inngest/client'
import { failUnstartedRun } from '@/engine/run'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

const bodySchema = z.object({ note: z.string().max(4000) })

// Another change on top of an approved one: a new run that starts from it. Starts an unattended agent, so only the
// app's own page may ask.
export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    const created = await startFollowUp(runId, body.data.note)
    try {
      await inngest.send({ name: RUN_REQUESTED, data: { runId: created.runId } })
    } catch {
      await failUnstartedRun(created.runId)
      return Response.json({ error: strings.run.couldNotStart, runId: created.runId }, { status: 503 })
    }
    return Response.json(created, { status: 201 })
  } catch (e) {
    if (e instanceof FollowUpError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}

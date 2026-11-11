import { z } from 'zod'
import { MAX_IMAGES } from '@/engine/attachments'
import { decideGate, GateError } from '@/engine/approvals'
import { APPROVAL_DECIDED, inngest } from '@/engine/inngest/client'
import { learnFrom } from '@/engine/memory'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

const bodySchema = z.object({
  decision: z.enum(['approved', 'rejected', 'changes']),
  reason: z.string().max(2000).nullable().optional(),
  diffHash: z.string().min(1),
  attachments: z.array(z.string()).max(MAX_IMAGES).optional(),
})

// The person's decision at a human check. Only from the app's own page; recorded before it is delivered.
export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    const row = await decideGate(runId, body.data, { send: data => inngest.send({ name: APPROVAL_DECIDED, data }) })
    // What the person said may hold for later tasks too: learned in the background, never in the way of the decision.
    const source = body.data.decision === 'approved' ? 'approved' : body.data.decision === 'rejected' ? 'rejected' : 'changes'
    void learnFrom(runId, body.data.reason, source).catch(() => undefined)
    return Response.json({ decision: row.decision, actor: row.actor, at: row.createdAt })
  } catch (e) {
    if (e instanceof GateError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}

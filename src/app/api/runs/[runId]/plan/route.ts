import { z } from 'zod'
import { inngest, PLAN_DECIDED } from '@/engine/inngest/client'
import { currentPlan, decidePlan, MAX_JOBS, PlanError } from '@/engine/plan'
import { learnFrom } from '@/engine/memory'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

type Ctx = { params: Promise<{ runId: string }> }

// The run's plan as it stands: the planner's proposal, or the person's edit of it. Reading only.
export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params
  return Response.json({ plan: (await currentPlan(runId)) })
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('build'), jobs: z.array(z.object({ title: z.string().max(400), done: z.array(z.string().max(400)).max(10) })).min(1).max(MAX_JOBS) }),
  z.object({ action: z.literal('replan'), note: z.string().min(1).max(2000) }),
])

// The person's word on the plan: build it as they left it, or plan again with their note. Recorded, then the run told.
export async function POST(req: Request, ctx: Ctx) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  try {
    await decidePlan(runId, body.data)
    if (body.data.action === 'replan') void learnFrom(runId, body.data.note, 'replan').catch(() => undefined)
  } catch (e) {
    if (e instanceof PlanError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
  try {
    await inngest.send({ name: PLAN_DECIDED, data: { runId } })
  } catch {
    // Recorded; the run reads it when it is next told. Said plainly rather than pretending it moved.
    return Response.json({ ok: true, delivered: false })
  }
  return Response.json({ ok: true, delivered: true })
}

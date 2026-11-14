import { z } from 'zod'
import { db } from '@/db/client'
import { questions } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { inngest } from '@/engine/inngest/client'
import { claimAttachments } from '@/engine/attachments'
import { answerQuestion, QuestionError } from '@/engine/questions'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

const bodySchema = z.object({
  option: z.string().trim().min(1),
  text: z.string().optional(),
  /** Images that go with a request made in direct edit. */
  attachments: z.array(z.string()).max(10).optional(),
})

// The person's answer to a question. Only from the app's own page; recorded before it is delivered.
export async function POST(req: Request, ctx: { params: Promise<{ runId: string; questionId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId, questionId } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  // The question must be the one of the run in the address.
  const mine = (await db.select({ id: questions.id, kind: questions.kind, state: questions.state }).from(questions).where(and(eq(questions.id, questionId), eq(questions.runId, runId))))[0]
  if (!mine) return Response.json({ error: strings.question.notFound }, { status: 404 })
  try {
    // Tied to this pause before the answer is recorded, so the builder that goes on with it finds them.
    if (mine.kind === 'direct' && mine.state === 'open' && body.data.option === 'other' && body.data.attachments?.length) await claimAttachments(body.data.attachments, runId, null, questionId)
    const answered = await answerQuestion(questionId, { option: body.data.option, ...(body.data.text !== undefined ? { text: body.data.text } : {}) }, { send: e => inngest.send(e as Parameters<typeof inngest.send>[0]) })
    return Response.json(answered)
  } catch (e) {
    if (e instanceof QuestionError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}

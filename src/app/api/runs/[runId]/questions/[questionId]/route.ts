import { z } from 'zod'
import { db } from '@/db/client'
import { questions } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { inngest } from '@/engine/inngest/client'
import { answerQuestion, QuestionError } from '@/engine/questions'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

const bodySchema = z.object({
  option: z.string().trim().min(1),
  text: z.string().optional(),
})

// The person's answer to a question. Only from the app's own page; recorded before it is delivered.
export async function POST(req: Request, ctx: { params: Promise<{ runId: string; questionId: string }> }) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const { runId, questionId } = await ctx.params
  const body = bodySchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: strings.errors.invalidBody }, { status: 400 })
  // The question must be the one of the run in the address.
  const mine = (await db.select({ id: questions.id }).from(questions).where(and(eq(questions.id, questionId), eq(questions.runId, runId))))[0]
  if (!mine) return Response.json({ error: strings.question.notFound }, { status: 404 })
  try {
    const answered = await answerQuestion(questionId, body.data, { send: e => inngest.send(e as Parameters<typeof inngest.send>[0]) })
    return Response.json(answered)
  } catch (e) {
    if (e instanceof QuestionError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}

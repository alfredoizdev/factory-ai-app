import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs } from '@/db/schema'
import { viewOf } from '@/engine/finding-view'
import { findingsOf, problemGroups } from '@/engine/findings'
import { openQuestion } from '@/engine/questions'
import { clip, redact } from '@/engine/redact'
import { label, listRegister } from '@/engine/register'
import { strings } from '@/ui/strings'

// The problems the reviewers reported on this run and how each one ended (one entry per problem), and the question the
// run is waiting on, if any. `touched` is what the question's numbers stand for: the person's own words for each earlier
// decision or core area, so the screen never shows a bare number. Reading only.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  const run = (await db.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })
  const question = await openQuestion(runId)
  const findings = problemGroups(await findingsOf(runId)).map(viewOf)
  // The numbers the question refers to: the ones it lists, and any "D-07" in its sentences.
  const cited = new Set<number>(question?.touches ?? [])
  for (const m of `${question?.text ?? ''} ${question?.why ?? ''}`.matchAll(/\bD-(\d+)\b/g)) cited.add(Number(m[1]))
  const touched = cited.size === 0 ? [] : (await listRegister(run.projectId))
    .filter(e => cited.has(e.number) && e.kind !== 'finding')
    .map(e => ({ number: e.number, label: label(e.number), kind: e.kind, text: clip(redact(e.text), 600) }))
  return Response.json({ findings, question: question && { ...question, detail: question.detail === null ? null : clip(redact(question.detail), 1000) }, touched })
}

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs } from '@/db/schema'
import { askClaude, type AskModel } from '@/engine/branch-name'
import { runFailure, type FailedBlock } from '@/engine/failure'

// A failure said in words anyone can read. What a command printed is written for programmers; a small, fast model
// reads the end of it and says what happened and the likely reason in a few plain sentences. No model, a timeout or
// an answer that is not plain prose gives null, and the window keeps its own ready-made sentence.

const MAX_CHARS = 700

/** The model's answer, accepted only when it is a few lines of plain prose: no code fences, headings or lists. */
export function cleanExplanation(raw: string): string | null {
  if (/```|^\s*#|^\s*[-*] /m.test(raw)) return null
  const text = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\*\*/g, '')
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
  return text.length < 20 || text.length > MAX_CHARS ? null : text
}

export function explainPrompt(request: string, block: FailedBlock): string {
  return (
    'A check failed while software agents were building something for a person who is NOT a programmer. Explain it to ' +
    'that person. Reply with plain text only: 2 or 3 short sentences, 50 words at most, everyday words, no code, no file paths, no ' +
    'markdown, no advice about commands. Sentence 1: what happened. Sentence 2: the most likely reason, in simple ' +
    'terms. If the output does not show a clear reason, say that honestly. Do not say what to do next.\n' +
    `What the person asked for: ${request.slice(0, 600)}\n` +
    `The check that failed: ${block.label}${block.command ? ` (it ran: ${block.command})` : ''}\n` +
    `What the app said: ${block.message ?? 'nothing'}\n` +
    `The end of what the check printed:\n${(block.output ?? 'nothing').slice(-6000)}`
  )
}

// One answer per run for as long as the app is up: opening the window again does not ask the model again.
const answered = new Map<string, string>()

/** The first failed block of a run, explained in plain words. Null when there is nothing to explain or no answer. */
export async function explainFailure(runId: string, ask: AskModel = askClaude): Promise<string | null> {
  const known = answered.get(runId)
  if (known) return known
  const failure = await runFailure(runId)
  const block = failure?.failed[0]
  if (!block || (!block.output && !block.message)) return null
  const run = (await db.select({ request: runs.request }).from(runs).where(eq(runs.id, runId)))[0]
  try {
    const text = cleanExplanation(await ask(explainPrompt(run?.request ?? '', block)))
    if (text) answered.set(runId, text)
    return text
  } catch {
    return null
  }
}

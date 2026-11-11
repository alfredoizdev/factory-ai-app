import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs } from '@/db/schema'
import { askClaude, type AskModel } from '@/engine/branch-name'
import { clip, redact } from '@/engine/redact'

// A task's title: a few words that tell it apart in the list and on the canvas. The person's own when they give one;
// otherwise a plain cut of the request at once, then a better one from a fast model, which never replaces a title the
// person wrote.

export const MAX_TITLE = 60

/** A title as given (by a person or a model): one line, no wrapping quotes, bounded; null when nothing is left. */
export function cleanTitle(raw: string): string | null {
  const line = (raw.trim().split('\n')[0] ?? '').trim().replace(/^["'`“”]+|["'`“”.]+$/g, '').replace(/^title:\s*/i, '').trim()
  if (line === '') return null
  return clip(redact(line), MAX_TITLE)
}

/** The request's first clause, without paths in brackets, cut at a word: something to call the task straight away. */
export function fallbackTitle(request: string): string {
  const plain = request.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  const clause = plain.split(/(?<=[.:;!?])\s/)[0] ?? plain
  const words = clause.replace(/[.:;!?]+$/, '').split(' ').filter(Boolean)
  let out = ''
  for (const w of words) {
    if ((out + ' ' + w).trim().length > 48) break
    out = (out + ' ' + w).trim()
  }
  const title = out || plain.slice(0, 48)
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** A short title for the request, in its own language, from a fast model; null when it gives nothing usable. */
export async function suggestTitle(request: string, ask: AskModel = askClaude): Promise<string | null> {
  const prompt =
    'Give this task a short title of 2 to 6 words, in the same language as the request, saying what changes. ' +
    `Reply with ONLY the title.\nRequest: ${request.slice(0, 2000)}`
  try {
    return cleanTitle(await ask(prompt))
  } catch {
    return null
  }
}

/** The title shown for a run: its own, or a cut of its request for runs from before titles. */
export function titleOf(run: { title: string | null; request: string }): string {
  return run.title ?? fallbackTitle(run.request)
}

/** Renames a task. Marked as the person's, so a suggestion arriving later never overwrites it. */
export function setRunTitle(runId: string, raw: string): string | null {
  const title = cleanTitle(raw)
  if (!title) return null
  const changed = db.update(runs).set({ title, titleByPerson: true }).where(eq(runs.id, runId)).run().changes
  return changed > 0 ? title : null
}

/** Replaces a task's quick title with a model's better one, unless the person has named it since. */
export async function improveTitle(runId: string, request: string, ask: AskModel = askClaude): Promise<void> {
  const better = await suggestTitle(request, ask)
  if (!better) return
  const run = db.select({ byPerson: runs.titleByPerson }).from(runs).where(eq(runs.id, runId)).get()
  if (!run || run.byPerson) return
  db.update(runs).set({ title: better }).where(eq(runs.id, runId)).run()
}

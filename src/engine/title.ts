import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs } from '@/db/schema'
import { clip, redact } from '@/engine/redact'

// A task's title: a few words the person gives it, to tell it apart in the list and on the canvas. Only theirs: the
// app never names a task for them.

export const MAX_TITLE = 60

/** A title as given (by a person or a model): one line, no wrapping quotes, bounded; null when nothing is left. */
export function cleanTitle(raw: string): string | null {
  const line = (raw.trim().split('\n')[0] ?? '').trim().replace(/^["'`“”]+|["'`“”.]+$/g, '').replace(/^title:\s*/i, '').trim()
  if (line === '') return null
  return clip(redact(line), MAX_TITLE)
}

/** The title shown for a run: the person's own, or none. */
export function titleOf(run: { title: string | null }): string | null {
  return run.title
}

/** Renames a task. Marked as the person's, so a suggestion arriving later never overwrites it. */
export function setRunTitle(runId: string, raw: string): string | null {
  const title = cleanTitle(raw)
  if (!title) return null
  const changed = db.update(runs).set({ title, titleByPerson: true }).where(eq(runs.id, runId)).run().changes
  return changed > 0 ? title : null
}

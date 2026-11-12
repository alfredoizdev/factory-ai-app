import { and, asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { projectNotes, runs } from '@/db/schema'
import { askClaude, type AskModel } from '@/engine/branch-name'
import { appendEventSync, type DbHandle, lockRun } from '@/engine/events'
import { clip, redact } from '@/engine/redact'

// The project's memory. What the person says on one task often holds for the next ("use the team's pink", "do not
// touch the header"). A fast model reads each thing they said and keeps only a lasting rule, or nothing; the person
// can also write rules by hand. Every task starts with the rules switched on, and records which it was given, so the
// card can show them. A rule a model distilled is still the person's words, shortened: where it came from is kept.

export type NoteSource = 'person' | 'approved' | 'changes' | 'rejected' | 'replan'
export type ProjectNote = { id: string; text: string; source: NoteSource; runId: string | null; enabled: boolean; createdAt: string }

export const MAX_NOTE = 240
/** How many rules a task is given, newest first: enough to matter, few enough to read. */
export const MAX_GIVEN = 20

const now = () => new Date().toISOString()

export function cleanNote(raw: string): string | null {
  const text = clip(redact(raw.replace(/\s+/g, ' ').trim()), MAX_NOTE)
  return text === '' ? null : text
}

export async function listNotes(projectId: string, h: DbHandle = db): Promise<ProjectNote[]> {
  return (await h.select().from(projectNotes).where(eq(projectNotes.projectId, projectId)).orderBy(asc(projectNotes.createdAt))) as ProjectNote[]
}

export async function addNote(projectId: string, raw: string, source: NoteSource = 'person', runId: string | null = null): Promise<ProjectNote | null> {
  const text = cleanNote(raw)
  if (!text) return null
  // The same rule twice is noise: a repeat is not added again.
  if ((await listNotes(projectId)).some(n => n.text.toLowerCase() === text.toLowerCase())) return null
  const note: ProjectNote = { id: ulid(), text, source, runId, enabled: true, createdAt: now() }
  await db.insert(projectNotes).values({ ...note, projectId })
  return note
}

export async function updateNote(projectId: string, id: string, change: { text?: string; enabled?: boolean }): Promise<ProjectNote | null> {
  const set: { text?: string; enabled?: boolean } = {}
  if (change.text !== undefined) {
    const text = cleanNote(change.text)
    if (!text) return null
    set.text = text
  }
  if (change.enabled !== undefined) set.enabled = change.enabled
  const where = and(eq(projectNotes.id, id), eq(projectNotes.projectId, projectId))
  if ((await db.update(projectNotes).set(set).where(where).returning({ id: projectNotes.id })).length === 0) return null
  return ((await db.select().from(projectNotes).where(where))[0] as ProjectNote | undefined) ?? null
}

export async function deleteNote(projectId: string, id: string): Promise<boolean> {
  return (await db.delete(projectNotes).where(and(eq(projectNotes.id, id), eq(projectNotes.projectId, projectId))).returning({ id: projectNotes.id })).length > 0
}

/** The rules a task starts with: switched on, newest first, bounded. */
export async function rulesFor(projectId: string, h: DbHandle = db): Promise<ProjectNote[]> {
  return (await listNotes(projectId, h)).filter(n => n.enabled).reverse().slice(0, MAX_GIVEN).reverse()
}

/**
 * Records, on the run, the rules it was given, and returns their texts. Once per run: a replay returns what was
 * recorded the first time, so a rule added meanwhile does not change a task already going.
 */
export async function giveRules(runId: string): Promise<string[]> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return []
  return db.transaction(
    async tx => {
      await lockRun(tx, runId)
      const recorded = (await tx.select().from(runs).where(eq(runs.id, runId)))[0]?.memoryJson
      if (recorded) return JSON.parse(recorded) as string[]
      const texts = (await rulesFor(run.projectId, tx)).map(n => n.text)
      await tx.update(runs).set({ memoryJson: JSON.stringify(texts) }).where(eq(runs.id, runId))
      if (texts.length > 0) await appendEventSync({ runId, type: 'run.memory', payload: { notes: texts } }, tx)
      return texts
    },
  )
}

/** A lasting rule from one thing the person said on a task, or null when it was only about that task. */
export async function distill(request: string, said: string, ask: AskModel = askClaude): Promise<string | null> {
  const prompt =
    'A person is directing an AI that changes their website. On one task they asked for this:\n' +
    `${request.slice(0, 1500)}\n\nThen they said:\n${said.slice(0, 1500)}\n\n` +
    'If what they said contains a preference or rule that should also apply to FUTURE tasks on this project (style, ' +
    'things to avoid, how they like work done), reply with that rule as one short sentence in the same language they ' +
    'used. If it only concerns this one task, reply with exactly NONE. Reply with nothing else.'
  try {
    const line = (await ask(prompt)).trim().split('\n')[0]?.trim() ?? ''
    if (line === '' || /^none\.?$/i.test(line)) return null
    return cleanNote(line.replace(/^["'`]+|["'`]+$/g, ''))
  } catch {
    return null
  }
}

/** Learns from what the person said on a task, in the background. Never throws. */
export async function learnFrom(runId: string, said: string | null | undefined, source: Exclude<NoteSource, 'person'>, ask: AskModel = askClaude): Promise<void> {
  if (!said?.trim()) return
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return
  const rule = await distill(run.request, said, ask)
  if (rule) (await addNote(run.projectId, rule, source, runId))
}

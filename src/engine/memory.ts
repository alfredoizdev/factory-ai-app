import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { projectNotes, runs } from '@/db/schema'
import { askClaude, type AskModel } from '@/engine/branch-name'
import type { DbHandle } from '@/engine/events'
import { projectHere } from '@/engine/machine'
import { clip, redact } from '@/engine/redact'
import { addEntry, CoreError, listRegister, MAX_GIVEN, normaliseCorePath, toEntry, type Entry, type EntryKind } from '@/engine/register'
import { strings } from '@/ui/strings'

export { MAX_GIVEN }

// The project's memory. What the person says on one task often holds for the next ("use the team's pink", "do not
// touch the header"). A fast model reads each thing they said and keeps only a lasting rule, or nothing; the person
// can also write rules by hand. Every task starts with the rules switched on, and records which it was given, so the
// card can show them. A rule a model distilled is still the person's words, shortened: where it came from is kept.

export type NoteSource = 'person' | 'approved' | 'changes' | 'rejected' | 'replan'
export type ProjectNote = { id: string; number: number; kind: EntryKind; text: string; paths: string[]; source: NoteSource; runId: string | null; enabled: boolean; createdAt: string }

export const MAX_NOTE = 240
/** A decision is written by the app from a question and its answer, so it may be longer than a rule. */
const MAX_ENTRY = 600
/** What the person can reword, switch off and remove. A finding line is a log of what happened: it is not theirs to edit. */
const EDITABLE: readonly EntryKind[] = ['rule', 'decision', 'core']

export function cleanNote(raw: string, max: number = MAX_NOTE): string | null {
  const text = clip(redact(raw.replace(/\s+/g, ' ').trim()), max)
  return text === '' ? null : text
}

const toNote = (e: Pick<Entry, 'id' | 'number' | 'kind' | 'text' | 'paths' | 'source' | 'runId' | 'enabled' | 'createdAt'>): ProjectNote => ({ id: e.id, number: e.number, kind: e.kind, text: e.text, paths: e.paths, source: e.source as NoteSource, runId: e.runId, enabled: e.enabled, createdAt: e.createdAt })

/** The project's rules, oldest first. Decisions, core areas and finding lines are in the register, not here. */
export async function listNotes(projectId: string, h: DbHandle = db): Promise<ProjectNote[]> {
  return (await listRegister(projectId, h)).filter(e => e.kind === 'rule').map(toNote)
}

export async function addNote(projectId: string, raw: string, source: NoteSource = 'person', runId: string | null = null): Promise<ProjectNote | null> {
  const text = cleanNote(raw)
  if (!text) return null
  // The same rule twice is noise: a repeat is not added again.
  if ((await listNotes(projectId)).some(n => n.text.toLowerCase() === text.toLowerCase())) return null
  const entry = await addEntry(projectId, { kind: 'rule', text, source, runId })
  return entry ? toNote(entry) : null
}

/**
 * Rewords an entry, switches it off or on, or (a core area) moves it to another folder or file. Rules, decisions and core
 * areas only: a finding line is a log. Throws a CoreError with the plain sentence when the new path is refused.
 */
export async function updateNote(projectId: string, id: string, change: { text?: string; enabled?: boolean; path?: string }): Promise<ProjectNote | null> {
  const where = and(eq(projectNotes.id, id), eq(projectNotes.projectId, projectId), inArray(projectNotes.kind, [...EDITABLE]))
  const current = (await db.select().from(projectNotes).where(where))[0]
  if (!current) return null
  const set: { text?: string; enabled?: boolean; paths?: string } = {}
  if (change.text !== undefined) {
    const text = cleanNote(change.text, current.kind === 'rule' ? MAX_NOTE : MAX_ENTRY)
    if (!text) return null
    set.text = text
  }
  if (change.enabled !== undefined) set.enabled = change.enabled
  if (change.path !== undefined && current.kind === 'core') {
    const repoPath = (await projectHere(projectId))?.repoPath ?? null
    const n = normaliseCorePath(change.path, repoPath)
    if (!n.ok) throw new CoreError(n.reason)
    const before = (JSON.parse(current.paths ?? '[]') as string[]).join(', ')
    set.paths = JSON.stringify([n.path])
    // The sentence the app wrote for the old place follows the entry to the new one; the person's own words stay.
    if (set.text === undefined && strings.memory.core.isAppText(current.text, before)) set.text = strings.memory.core.entryText(n.path)
  }
  if (Object.keys(set).length > 0) await db.update(projectNotes).set(set).where(where)
  const row = (await db.select().from(projectNotes).where(where))[0]
  return row ? toNote(toEntry(row)) : null
}

export async function deleteNote(projectId: string, id: string): Promise<boolean> {
  return (await db.delete(projectNotes).where(and(eq(projectNotes.id, id), eq(projectNotes.projectId, projectId), inArray(projectNotes.kind, [...EDITABLE]))).returning({ id: projectNotes.id })).length > 0
}

/** The rules a task starts with: switched on, newest first, bounded. */
export async function rulesFor(projectId: string, h: DbHandle = db): Promise<ProjectNote[]> {
  return (await listNotes(projectId, h)).filter(n => n.enabled).reverse().slice(0, MAX_GIVEN).reverse()
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

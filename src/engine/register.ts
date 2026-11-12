import { and, asc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { projectNotes, projects, runs } from '@/db/schema'
import { appendEventSync, type DbHandle, lockRun } from '@/engine/events'
import { SENSITIVE } from '@/engine/risk'

// The project's numbered register: the short rules the person taught, the decisions made on earlier tasks, the core
// areas that always ask the person first, and the log lines of what reviewers found. One table (project_notes), one
// number per entry within a project. Numbers are never reused: a counter on the project only goes up.

export type EntryKind = 'rule' | 'decision' | 'core' | 'finding'
export type EntryOutcome = 'done' | 'asked_yes' | 'asked_no' | 'discarded' | 'unchecked' | 'open'
export type Entry = {
  id: string
  number: number
  kind: EntryKind
  text: string
  paths: string[]
  source: string
  runId: string | null
  enabled: boolean
  outcome: EntryOutcome | null
  reason: string | null
  createdAt: string
}
/** What a task is given to follow: an entry that stands until the person changes it. */
export type Standing = { number: number; kind: 'rule' | 'decision' | 'core'; text: string; paths: string[] }

const now = () => new Date().toISOString()

/** 7 -> "D-07": how an entry is named wherever a person or a reviewer refers to it. */
export const label = (n: number): string => `D-${String(n).padStart(2, '0')}`

type Row = typeof projectNotes.$inferSelect

function parsePaths(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function toEntry(r: Row): Entry {
  return {
    id: r.id,
    number: r.number ?? 0,
    kind: r.kind as EntryKind,
    text: r.text,
    paths: parsePaths(r.paths),
    source: r.source,
    runId: r.runId,
    enabled: r.enabled,
    outcome: (r.outcome as EntryOutcome | null) ?? null,
    reason: r.reason,
    createdAt: r.createdAt,
  }
}

/**
 * Adds an entry under the next number. The project's row is locked while the counter moves, so two entries added at
 * once get different numbers; the counter, not the highest number, is what is given out, so a deleted number stays gone.
 * Null when the project does not exist.
 */
export async function addEntry(
  projectId: string,
  e: { kind: EntryKind; text: string; paths?: string[]; source: string; runId?: string | null; outcome?: EntryOutcome; reason?: string },
  h: DbHandle = db,
): Promise<Entry | null> {
  const insert = async (tx: DbHandle): Promise<Entry | null> => {
    if ((await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update')).length === 0) return null
    const next = (
      await tx.update(projects).set({ registerSeq: sql`${projects.registerSeq} + 1` }).where(eq(projects.id, projectId)).returning({ n: projects.registerSeq })
    )[0]!.n
    const row = (
      await tx
        .insert(projectNotes)
        .values({
          id: ulid(),
          projectId,
          number: next,
          kind: e.kind,
          text: e.text,
          paths: e.paths && e.paths.length > 0 ? JSON.stringify(e.paths) : null,
          source: e.source,
          runId: e.runId ?? null,
          enabled: true,
          outcome: e.outcome ?? null,
          reason: e.reason ?? null,
          createdAt: now(),
        })
        .returning()
    )[0]!
    return toEntry(row)
  }
  // Inside a caller's transaction the lock lasts until that transaction ends; otherwise one is opened here.
  return 'rollback' in h ? insert(h) : db.transaction(tx => insert(tx))
}

export async function listRegister(projectId: string, h: DbHandle = db): Promise<Entry[]> {
  return (await h.select().from(projectNotes).where(eq(projectNotes.projectId, projectId)).orderBy(asc(projectNotes.number), asc(projectNotes.createdAt))).map(toEntry)
}

/** The entries a task is given: rules, decisions and core areas that are switched on. */
export async function standingFor(projectId: string, h: DbHandle = db): Promise<Standing[]> {
  return (await listRegister(projectId, h))
    .filter((e): e is Entry & { kind: Standing['kind'] } => e.enabled && e.kind !== 'finding')
    .map(e => ({ number: e.number, kind: e.kind, text: e.text, paths: e.paths }))
}

/** The path patterns of the core areas that are switched on. */
export async function corePaths(projectId: string, h: DbHandle = db): Promise<string[]> {
  return (await standingFor(projectId, h)).filter(s => s.kind === 'core').flatMap(s => s.paths)
}

/** Sensitive areas the changed files touch, as candidates for the person to mark as core. First matching area per file. */
export function coreCandidates(files: readonly string[]): { area: string; paths: string[] }[] {
  const byArea = new Map<string, string[]>()
  for (const f of files) {
    const hit = SENSITIVE.find(([re]) => re.test(f))
    if (hit) byArea.set(hit[1], [...(byArea.get(hit[1]) ?? []), f])
  }
  return [...byArea].map(([area, paths]) => ({ area, paths }))
}

/** A pattern ending in "/" is a folder and everything beneath it; any other pattern is that exact file. */
export function touchesCore(path: string, patterns: readonly string[]): boolean {
  return patterns.some(p => (p.endsWith('/') ? path.startsWith(p) : path === p))
}

/** Gives a number to every entry that has none, oldest first (what the migration does in SQL). Returns how many. */
export async function numberUnnumbered(projectId: string): Promise<number> {
  return db.transaction(async tx => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update')
    const rows = await tx
      .select({ id: projectNotes.id })
      .from(projectNotes)
      .where(and(eq(projectNotes.projectId, projectId), sql`${projectNotes.number} is null`))
      .orderBy(asc(projectNotes.createdAt), asc(projectNotes.id))
    for (const r of rows) {
      const next = (await tx.update(projects).set({ registerSeq: sql`${projects.registerSeq} + 1` }).where(eq(projects.id, projectId)).returning({ n: projects.registerSeq }))[0]!.n
      await tx.update(projectNotes).set({ number: next }).where(eq(projectNotes.id, r.id))
    }
    return rows.length
  })
}

/** Reads what a run recorded, tolerating the old shape (a list of rule texts, which become rules numbered 0). */
function readRecorded(raw: string): Standing[] {
  const v: unknown = JSON.parse(raw)
  if (!Array.isArray(v)) return []
  return v.flatMap((x): Standing[] =>
    typeof x === 'string'
      ? [{ number: 0, kind: 'rule', text: x, paths: [] }]
      : x && typeof x === 'object' && typeof (x as Standing).text === 'string'
        ? [{ number: (x as Standing).number ?? 0, kind: (x as Standing).kind ?? 'rule', text: (x as Standing).text, paths: (x as Standing).paths ?? [] }]
        : [],
  )
}

/**
 * Records, on the run, what it was given to follow, and returns it. Once per run: a replay returns what was recorded
 * the first time, so an entry added meanwhile does not change a task already going. Rules are the newest MAX_GIVEN;
 * decisions and core areas are always given.
 */
export async function giveStanding(runId: string): Promise<Standing[]> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return []
  return db.transaction(async tx => {
    await lockRun(tx, runId)
    const recorded = (await tx.select().from(runs).where(eq(runs.id, runId)))[0]?.memoryJson
    if (recorded) return readRecorded(recorded)
    const all = await standingFor(run.projectId, tx)
    const rules = all.filter(s => s.kind === 'rule')
    const keep = new Set(rules.slice(Math.max(0, rules.length - MAX_GIVEN)))
    const given = all.filter(s => s.kind !== 'rule' || keep.has(s))
    await tx.update(runs).set({ memoryJson: JSON.stringify(given) }).where(eq(runs.id, runId))
    const texts = given.filter(s => s.kind === 'rule').map(s => s.text)
    if (texts.length > 0) await appendEventSync({ runId, type: 'run.memory', payload: { notes: texts } }, tx)
    return given
  })
}

/** How many rules a task is given, newest first: enough to matter, few enough to read. */
export const MAX_GIVEN = 20

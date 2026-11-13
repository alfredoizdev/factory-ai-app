import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { projectNotes, projects, runs } from '@/db/schema'
import { appendEventSync, type DbHandle, lockRun } from '@/engine/events'
import { projectHere } from '@/engine/machine'
import { SENSITIVE, insideCoreArea, type DecisionPaths } from '@/engine/risk'
import { strings } from '@/ui/strings'

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

export { label } from '@/domain/register-labels'

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

export function toEntry(r: Row): Entry {
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

/**
 * What a change is measured against besides its size: the core areas and the decisions that name files. The one place
 * the plan's measure, the final check and the review depth read it from, so they cannot disagree about the same change.
 * `run`: the run being measured. A decision the person made by answering a question on that very run settled the
 * matter for it, so it does not stop that run again; it counts for every other run, follow-ups included.
 */
export async function gateInputs(projectId: string, h: DbHandle = db, run?: string): Promise<{ core: string[]; decisions: DecisionPaths[] }> {
  const standing = (await listRegister(projectId, h)).filter(e => e.enabled && e.kind !== 'finding')
  const ownAnswer = (e: Entry) => run !== undefined && e.kind === 'decision' && e.source === 'question' && e.runId === run
  return {
    core: standing.filter(e => e.kind === 'core').flatMap(e => e.paths),
    decisions: standing.filter(e => e.kind === 'decision' && e.paths.length > 0 && !ownAnswer(e)).map(e => ({ text: e.text, paths: e.paths })),
  }
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
  return patterns.some(p => insideCoreArea(path, p))
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

/** A refusal the person can read as it is. */
export class CoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoreError'
  }
}

export type CorePath = { ok: true; path: string } | { ok: false; reason: string }

/**
 * What the person typed for a core area, as what `touchesCore` needs: repo-relative, forward slashes, no "./" or leading
 * "/", a trailing "/" on a folder and none on a file. Whether it is a folder is read from the project's own folder
 * here, never taken from the client. Refused: nothing, a way out of the project (".." or an absolute path), and, when
 * the project's folder can be read, something that is not in it.
 */
export function normaliseCorePath(raw: string, repoPath: string | null): CorePath {
  const slashed = raw.trim().replace(/\\/g, '/')
  const outside = { ok: false as const, reason: strings.memory.core.outside }
  const root = repoPath ? repoPath.replace(/\\/g, '/').replace(/\/+$/, '') : null
  if (/^[A-Za-z]:/.test(slashed) || slashed.startsWith('~') || (root && (slashed === root || slashed.startsWith(`${root}/`)))) return outside
  const parts = slashed.split('/').filter(p => p !== '' && p !== '.')
  if (parts.includes('..')) return outside
  if (parts.length === 0) return { ok: false, reason: strings.memory.core.empty }
  const path = parts.join('/')
  const folderWritten = slashed.endsWith('/')
  if (!repoPath || !existsSync(repoPath)) return { ok: true, path: folderWritten ? `${path}/` : path }
  try {
    const rootReal = realpathSync(repoPath)
    const real = realpathSync(join(repoPath, path))
    const inside = relative(rootReal, real)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return outside
    if (inside === '') return { ok: false, reason: strings.memory.core.empty }
    // The path as the project names it: a link is followed (realpath above), and each name takes the case it has on disk,
    // because touchesCore compares with the paths git reports, letter for letter.
    const named: string[] = []
    let here = rootReal
    for (const seg of inside.split(sep)) {
      const names = readdirSync(here)
      const hit = names.includes(seg) ? seg : names.find(n => n.toLowerCase() === seg.toLowerCase())
      if (hit === undefined) return { ok: false, reason: strings.memory.core.notFound }
      named.push(hit)
      here = join(here, hit)
    }
    return { ok: true, path: `${named.join('/')}${statSync(real).isDirectory() ? '/' : ''}` }
  } catch {
    return { ok: false, reason: strings.memory.core.notFound }
  }
}

/** Marks core areas the person chose: one path they typed, or the files of a suggestion they confirmed. */
export async function addCoreArea(projectId: string, a: { path?: string; paths?: string[]; area?: string }): Promise<Entry> {
  // The folder this computer has for the project (per computer, not the column from before machines).
  const project = await projectHere(projectId)
  if (!project) throw new CoreError(strings.memory.notFound)
  const given = a.paths ?? (a.path !== undefined ? [a.path] : [])
  const paths: string[] = []
  for (const raw of given.length > 0 ? given : ['']) {
    const n = normaliseCorePath(raw, project.repoPath)
    if (!n.ok) throw new CoreError(n.reason)
    if (!paths.includes(n.path)) paths.push(n.path)
  }
  const have = (await listRegister(projectId)).filter(e => e.kind === 'core').flatMap(e => e.paths)
  if (paths.every(p => have.includes(p))) throw new CoreError(strings.memory.core.already)
  const text = a.area?.trim() ? strings.memory.core.areaText(a.area.trim()) : strings.memory.core.entryText(paths.join(', '))
  const entry = await addEntry(projectId, { kind: 'core', text, paths, source: 'person' })
  if (!entry) throw new CoreError(strings.memory.notFound)
  return entry
}

/** The sensitive areas touched by the files of the project's latest change on record, that are not core already. */
export async function candidatesFor(projectId: string): Promise<{ area: string; paths: string[] }[]> {
  const latest = (
    await db.select({ reviewJson: runs.reviewJson }).from(runs).where(and(eq(runs.projectId, projectId), isNotNull(runs.reviewJson))).orderBy(desc(runs.createdAt)).limit(1)
  )[0]
  if (!latest?.reviewJson) return []
  let files: string[] = []
  try {
    const v = (JSON.parse(latest.reviewJson) as { files?: { path?: unknown }[] }).files
    files = Array.isArray(v) ? v.flatMap(f => (typeof f?.path === 'string' ? [f.path] : [])) : []
  } catch {
    return []
  }
  const core = await corePaths(projectId)
  return coreCandidates(files.filter(f => !touchesCore(f, core)))
}

import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { deleteNote, updateNote } from '@/engine/memory'
import { setLocal } from '@/engine/machine'
import { addCoreArea, candidatesFor, CoreError, corePaths, listRegister, normaliseCorePath, addEntry, touchesCore } from '@/engine/register'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { eq } from 'drizzle-orm'
import { strings } from '@/ui/strings'
import { DELETE, PATCH } from '@/app/api/projects/[id]/notes/[noteId]/route'
import { GET, POST } from '@/app/api/projects/[id]/notes/route'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-core-'))
  mkdirSync(join(dir, 'src/app'), { recursive: true })
  writeFileSync(join(dir, 'src/app/page.tsx'), 'x\n')
  writeFileSync(join(dir, 'package.json'), '{}\n')
  return dir
}
// As the real app has it: the shared row has no folder (projects.repo_path is not used any more); this computer's folder is its own row.
async function project(repoPath: string | null = repo()): Promise<string> {
  const id = ulid()
  await db.insert(projects).values({ id, projectId: id, name: 'p', createdAt: now() })
  if (repoPath) await setLocal(id, { repoPath })
  return id
}

describe('normaliseCorePath', () => {
  const dir = repo()
  const ok = (raw: string) => normaliseCorePath(raw, dir)
  test('a folder in the project gets a trailing slash, whatever way it was written', () => {
    for (const raw of ['src/app', 'src/app/', './src/app', '/src/app', 'src\\app', '  src/app  ', 'src//app/', './src/./app']) expect(ok(raw)).toEqual({ ok: true, path: 'src/app/' })
  })
  test('a file stays as the exact repo-relative path', () => {
    expect(ok('./package.json')).toEqual({ ok: true, path: 'package.json' })
    expect(ok('src\\app\\page.tsx')).toEqual({ ok: true, path: 'src/app/page.tsx' })
  })
  test('the result is what touchesCore needs', () => {
    const p = (ok('./src/app') as { path: string }).path
    expect(touchesCore('src/app/page.tsx', [p])).toBe(true)
    expect(touchesCore('src/application/x.ts', [p])).toBe(false)
  })
  test('empty input, parent folders and absolute paths are refused with a plain sentence', () => {
    expect(ok('')).toEqual({ ok: false, reason: strings.memory.core.empty })
    expect(ok('  ./ ')).toEqual({ ok: false, reason: strings.memory.core.empty })
    expect(ok('../elsewhere')).toEqual({ ok: false, reason: strings.memory.core.outside })
    expect(ok('src/../../x')).toEqual({ ok: false, reason: strings.memory.core.outside })
    expect(ok('src\\..\\..\\x')).toEqual({ ok: false, reason: strings.memory.core.outside })
    expect(ok(`${dir}/src/app`)).toEqual({ ok: false, reason: strings.memory.core.outside })
    expect(ok('C:\\Users\\me\\proj')).toEqual({ ok: false, reason: strings.memory.core.outside })
    expect(ok('~/proj')).toEqual({ ok: false, reason: strings.memory.core.outside })
  })
  test('a path that is not in the project is refused when the project\'s folder can be read', () => {
    expect(ok('src/nothing')).toEqual({ ok: false, reason: strings.memory.core.notFound })
    expect(normaliseCorePath('src/nothing', null)).toEqual({ ok: true, path: 'src/nothing' })
  })
  test('the folder is checked on the server: a name ending in a slash is a folder even where it cannot be read', () => {
    expect(normaliseCorePath('src/future/', null)).toEqual({ ok: true, path: 'src/future/' })
  })
})

describe('normaliseCorePath: the path as the project really names it', () => {
  const dir = repo()
  symlinkSync(join(dir, 'src'), join(dir, 'inlink'))
  symlinkSync(mkdtempSync(join(tmpdir(), 'factory-elsewhere-')), join(dir, 'outlink'))
  const caseInsensitive = existsSync(join(dir, 'SRC'))
  test.runIf(caseInsensitive)('a wrong-case name is stored in the case git sees', () => {
    expect(normaliseCorePath('Src/App', dir)).toEqual({ ok: true, path: 'src/app/' })
    expect(normaliseCorePath('SRC/app/PAGE.tsx', dir)).toEqual({ ok: true, path: 'src/app/page.tsx' })
  })
  test('a folder reached through a link inside the project is stored as its real place in the project', () => {
    expect(normaliseCorePath('inlink/app', dir)).toEqual({ ok: true, path: 'src/app/' })
    expect(normaliseCorePath('inlink/app/page.tsx', dir)).toEqual({ ok: true, path: 'src/app/page.tsx' })
  })
  test('a link that leaves the project is still refused', () => {
    expect(normaliseCorePath('outlink', dir)).toEqual({ ok: false, reason: strings.memory.core.outside })
  })
})

describe('core areas', () => {
  test('adding one stores the normalised path and a plain sentence, numbered like any entry', async () => {
    const p = await project()
    const e = await addCoreArea(p, { path: './src/app' })
    expect(e).toMatchObject({ kind: 'core', paths: ['src/app/'], source: 'person', enabled: true })
    expect(e.text).toBe(strings.memory.core.entryText('src/app/'))
    expect(e.number).toBe(1)
    expect(await corePaths(p)).toEqual(['src/app/'])
  })
  test('the sentence a new core area is stored with says what the app does: a change there stops for the person\'s yes', async () => {
    const p = await project()
    const e = await addCoreArea(p, { path: 'src/app' })
    expect(e.text).toBe('A change to src/app/ always stops for your yes.')
    expect(e.text).not.toMatch(/Ask me before/)
    const s = await addCoreArea(p, { paths: ['package.json'], area: 'the settings of the project' })
    expect(s.text).toBe('These files deal with the settings of the project. A change to them always stops for your yes.')
  })
  test('an entry stored with the old sentence still follows a move, in the new words', async () => {
    const p = await project()
    const old = (await addEntry(p, { kind: 'core', text: 'Ask me before changing src/app/', paths: ['src/app/'], source: 'person' }))!
    expect((await updateNote(p, old.id, { path: 'package.json' }))!.text).toBe(strings.memory.core.entryText('package.json'))
  })
  test('a path that is not in this computer\'s folder for the project is refused', async () => {
    const p = await project()
    await expect(addCoreArea(p, { path: 'does/not/exist' })).rejects.toThrow(strings.memory.core.notFound)
    expect(await listRegister(p)).toEqual([])
  })
  test('a folder written in the wrong case is stored as git names it (where the disk ignores case)', async () => {
    const dir = repo()
    const p = await project(dir)
    if (!existsSync(join(dir, 'SRC'))) return
    expect((await addCoreArea(p, { path: 'SRC/App/' })).paths).toEqual(['src/app/'])
    const moved = await addCoreArea(p, { path: 'package.json' })
    expect((await updateNote(p, moved.id, { path: 'SRC/APP' }))!.paths).toEqual(['src/app/'])
  })
  test('a refused path throws the plain sentence and adds nothing; the same area twice is refused', async () => {
    const p = await project()
    await expect(addCoreArea(p, { path: '../x' })).rejects.toThrow(strings.memory.core.outside)
    await expect(addCoreArea(p, { path: '' })).rejects.toBeInstanceOf(CoreError)
    await addCoreArea(p, { path: 'src/app' })
    await expect(addCoreArea(p, { path: 'src/app/' })).rejects.toThrow(strings.memory.core.already)
    expect((await listRegister(p)).filter(e => e.kind === 'core')).toHaveLength(1)
  })
  test('a suggestion confirmed becomes a core area of exactly its files', async () => {
    const p = await project()
    const e = await addCoreArea(p, { paths: ['package.json'], area: 'the settings of the project' })
    expect(e.paths).toEqual(['package.json'])
    expect(e.text).toBe(strings.memory.core.areaText('the settings of the project'))
  })
  test('a decision can be reworded and a core area moved, switched off, and removed; a finding line cannot be touched', async () => {
    const p = await project()
    const d = (await addEntry(p, { kind: 'decision', text: 'Use Stripe — Yes', source: 'question' }))!
    expect((await updateNote(p, d.id, { text: 'Use Stripe for payments' }))!.text).toBe('Use Stripe for payments')
    const c = await addCoreArea(p, { path: 'src/app' })
    const moved = (await updateNote(p, c.id, { path: './package.json' }))!
    expect(moved.paths).toEqual(['package.json'])
    expect((await updateNote(p, c.id, { enabled: false }))!.enabled).toBe(false)
    expect(await corePaths(p)).toEqual([])
    await expect(updateNote(p, c.id, { path: '../out' })).rejects.toThrow(strings.memory.core.outside)
    const f = (await addEntry(p, { kind: 'finding', text: 'a finding', source: 'provider', outcome: 'open' }))!
    expect(await updateNote(p, f.id, { text: 'changed' })).toBeNull()
    expect(await deleteNote(p, f.id)).toBe(false)
    expect(await deleteNote(p, d.id)).toBe(true)
    expect(await deleteNote(p, c.id)).toBe(true)
    expect((await listRegister(p)).map(e => e.kind)).toEqual(['finding'])
    expect(await deleteNote('another-project', d.id)).toBe(false)
  })
  test('the number of a removed entry is not given again', async () => {
    const p = await project()
    const a = await addCoreArea(p, { path: 'src/app' })
    await deleteNote(p, a.id)
    expect((await addCoreArea(p, { path: 'package.json' })).number).toBe(2)
  })
})

describe('suggestions', () => {
  test('come from the files of the project\'s latest change, minus what is already core', async () => {
    const p = await project()
    const workflowId = ulid()
    await db.insert(workflows).values({ id: workflowId, projectId: p, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
    await saveDraft(workflowId, defaultGraph())
    await publishVersion(workflowId)
    const { runId } = await createRun({ workflowId, request: 'x' })
    const files = [{ path: 'src/lib/auth.ts', added: 1, removed: 0 }, { path: 'src/app/api/pay/route.ts', added: 1, removed: 0 }, { path: 'README.md', added: 1, removed: 0 }]
    await db.update(runs).set({ reviewJson: JSON.stringify({ hash: 'h', files, diff: '', truncated: false }) }).where(eq(runs.id, runId))
    expect((await candidatesFor(p)).flatMap(c => c.paths).sort()).toEqual(['src/app/api/pay/route.ts', 'src/lib/auth.ts'])
    await addEntry(p, { kind: 'core', text: 'x', paths: ['src/lib/'], source: 'person' })
    expect((await candidatesFor(p)).flatMap(c => c.paths)).toEqual(['src/app/api/pay/route.ts'])
  })
  test('none when the project has no change on record', async () => {
    expect(await candidatesFor(await project())).toEqual([])
  })
})

describe('the notes routes', () => {
  const HOST = 'localhost:3000'
  const own = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }
  const req = (method: string, body?: unknown, headers: Record<string, string> = own) =>
    new Request(`http://${HOST}/x`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const ctx = (id: string, noteId?: string) => ({ params: Promise.resolve({ id, noteId: noteId ?? '' }) })

  test('GET lists every kind with its number, and the suggestions', async () => {
    const p = await project()
    await addEntry(p, { kind: 'rule', text: 'Buttons are blue', source: 'person' })
    await addEntry(p, { kind: 'decision', text: 'Use Stripe', source: 'question' })
    const body = (await (await GET(req('GET'), ctx(p))).json()) as { notes: unknown[]; entries: { number: number; kind: string }[]; candidates: unknown[] }
    expect(body.notes).toHaveLength(1)
    expect(body.entries.map(e => [e.number, e.kind])).toEqual([[1, 'rule'], [2, 'decision']])
    expect(body.candidates).toEqual([])
  })
  test('POST adds a core area; a refused path answers 400 with the plain sentence', async () => {
    const p = await project()
    const res = await POST(req('POST', { kind: 'core', path: './src/app' }), ctx(p))
    expect(res.status).toBe(201)
    expect(((await res.json()) as { note: { paths: string[] } }).note.paths).toEqual(['src/app/'])
    const bad = await POST(req('POST', { kind: 'core', path: '../x' }), ctx(p))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe(strings.memory.core.outside)
  })
  test('POST without the app\'s own page headers is refused', async () => {
    const p = await project()
    expect((await POST(req('POST', { kind: 'core', path: 'src/app' }, { host: HOST }), ctx(p))).status).toBe(403)
  })
  test('PATCH moves a core area and rewords a decision; DELETE removes either', async () => {
    const p = await project()
    const core = await addCoreArea(p, { path: 'src/app' })
    const d = (await addEntry(p, { kind: 'decision', text: 'Use Stripe', source: 'question' }))!
    const moved = await PATCH(req('PATCH', { path: 'package.json' }), ctx(p, core.id))
    expect(((await moved.json()) as { note: { paths: string[] } }).note.paths).toEqual(['package.json'])
    expect((await PATCH(req('PATCH', { path: '/../x' }), ctx(p, core.id))).status).toBe(400)
    const reworded = await PATCH(req('PATCH', { text: 'Use Stripe only' }), ctx(p, d.id))
    expect(((await reworded.json()) as { note: { text: string } }).note.text).toBe('Use Stripe only')
    expect((await DELETE(req('DELETE'), ctx(p, d.id))).status).toBe(204)
    expect((await DELETE(req('DELETE'), ctx(p, core.id))).status).toBe(204)
    expect((await DELETE(req('DELETE'), ctx(p, core.id))).status).toBe(404)
  })
})

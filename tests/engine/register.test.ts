import { eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projectNotes, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { addEntry, coreCandidates, corePaths, gateInputs, giveStanding, label, listRegister, numberUnnumbered, standingFor, touchesCore } from '@/engine/register'
import { measurePlan } from '@/engine/plan-measure'
import { classifyChange, type DecisionPaths } from '@/engine/risk'
import { strings } from '@/ui/strings'
import { createRun, publishVersion, saveDraft } from '@/engine/run'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

async function project(): Promise<string> {
  const id = ulid()
  await db.insert(projects).values({ id, projectId: id, name: 'p', createdAt: now(), repoPath: '/repo' })
  return id
}
const rule = (text: string) => ({ kind: 'rule' as const, text, source: 'person' })

test('numbers are per project, start at 1 and are never reused', async () => {
  const p = await project()
  const other = await project()
  const a = (await addEntry(p, rule('a')))!
  const b = (await addEntry(p, rule('b')))!
  const c = (await addEntry(p, rule('c')))!
  expect([a.number, b.number, c.number]).toEqual([1, 2, 3])
  await db.delete(projectNotes).where(eq(projectNotes.id, b.id))
  expect((await addEntry(p, rule('d')))!.number).toBe(4)
  expect((await listRegister(p)).map(e => e.number)).toEqual([1, 3, 4])
  expect((await addEntry(other, rule('x')))!.number).toBe(1)
})

test('deleting the highest number does not free it', async () => {
  const p = await project()
  await addEntry(p, rule('a'))
  await addEntry(p, rule('b'))
  const c = (await addEntry(p, rule('c')))!
  await db.delete(projectNotes).where(eq(projectNotes.id, c.id))
  expect((await addEntry(p, rule('d')))!.number).toBe(4)
})

test('two entries added at once get different numbers', async () => {
  const p = await project()
  const added = await Promise.all([1, 2, 3, 4, 5].map(i => addEntry(p, rule(`r${i}`))))
  expect(new Set(added.map(e => e!.number)).size).toBe(5)
  expect(added.map(e => e!.number).sort()).toEqual([1, 2, 3, 4, 5])
})

test('an entry for a project that does not exist is not added', async () => {
  expect(await addEntry('nobody', rule('a'))).toBeNull()
})

test('existing rules are numbered by the migration in the order they were written', async () => {
  const p = await project()
  for (const [i, t] of ['2026-01-03', '2026-01-01', '2026-01-02'].entries()) {
    await db.execute(sql`insert into project_notes (id, project_id, text, source, enabled, created_at) values (${`n${i}-${p}`}, ${p}, ${`t${i}`}, 'person', true, ${t})`)
  }
  expect(await numberUnnumbered(p)).toBe(3)
  expect((await listRegister(p)).map(e => [e.number, e.text])).toEqual([[1, 't1'], [2, 't2'], [3, 't0']])
  expect((await addEntry(p, rule('next')))!.number).toBe(4)
})

test('standingFor leaves out finding lines and switched-off entries', async () => {
  const p = await project()
  await addEntry(p, rule('keep pink'))
  await addEntry(p, { kind: 'decision', text: 'we use Stripe', source: 'person' })
  await addEntry(p, { kind: 'core', text: 'payments', paths: ['src/billing/'], source: 'person' })
  await addEntry(p, { kind: 'finding', text: 'a finding', source: 'provider', outcome: 'open' })
  const off = (await addEntry(p, rule('switched off')))!
  await db.update(projectNotes).set({ enabled: false }).where(eq(projectNotes.id, off.id))
  expect((await standingFor(p)).map(s => [s.number, s.kind, s.text, s.paths])).toEqual([
    [1, 'rule', 'keep pink', []],
    [2, 'decision', 'we use Stripe', []],
    [3, 'core', 'payments', ['src/billing/']],
  ])
  expect(await corePaths(p)).toEqual(['src/billing/'])
  const f = (await listRegister(p)).find(e => e.kind === 'finding')!
  expect(f.outcome).toBe('open')
})

test('label pads to two digits', () => {
  expect(label(7)).toBe('D-07')
  expect(label(123)).toBe('D-123')
})

test('coreCandidates names the sensitive areas the files are in', () => {
  const c = coreCandidates(['src/app/api/pay/route.ts', 'src/lib/auth.ts', 'README.md'])
  expect(c.map(x => x.paths)).toEqual([['src/app/api/pay/route.ts'], ['src/lib/auth.ts']])
  expect(c.every(x => x.area !== '')).toBe(true)
  expect(coreCandidates(['README.md'])).toEqual([])
})

test('touchesCore: a folder pattern covers what is beneath it, any other pattern is that file only', () => {
  expect(touchesCore('src/billing/x.ts', ['src/billing/'])).toBe(true)
  expect(touchesCore('src/billing2/x.ts', ['src/billing/'])).toBe(false)
  expect(touchesCore('src/auth.ts', ['src/auth.ts'])).toBe(true)
  expect(touchesCore('src/auth.ts.bak', ['src/auth.ts'])).toBe(false)
  expect(touchesCore('src/auth/x.ts', ['src/auth'])).toBe(false)
})

test('giveStanding records once per run, always gives decisions and core areas, and reads the old shape', async () => {
  const p = await project()
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, projectId: p, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'x' })
  await addEntry(p, { kind: 'decision', text: 'D', source: 'person' })
  for (let i = 0; i < 22; i++) await addEntry(p, rule(`rule ${i}`))
  const first = await giveStanding(runId)
  expect(first.filter(s => s.kind === 'rule')).toHaveLength(20)
  expect(first.filter(s => s.kind === 'decision')).toHaveLength(1)
  await addEntry(p, rule('later'))
  expect(await giveStanding(runId)).toEqual(first)
  await db.update(runs).set({ memoryJson: JSON.stringify(['old rule']) }).where(eq(runs.id, runId))
  expect(await giveStanding(runId)).toEqual([{ number: 0, kind: 'rule', text: 'old rule', paths: [] }])
})

describe('a folder stored without its slash still counts as that folder', () => {
  const passing = { testsRan: true, testsPassed: true, testsChanged: false }
  const plan = (paths: string[]) => ({ jobs: [{ title: 'Round', done: [], paths }], question: null })
  const final = (path: string, g: { core: string[]; decisions: DecisionPaths[] }) => classifyChange([{ path, lines: 2 }], passing, g.core, g.decisions)

  test('a core area written as "src/rounding" stops a plan naming a file or the folder, and the final check on a file inside', async () => {
    const p = await project()
    await addEntry(p, { kind: 'core', text: 'Rounding', paths: ['src/rounding'], source: 'person' })
    const g = await gateInputs(p)
    expect(measurePlan(plan(['src/rounding/round.ts']), g).simple).toBe(false)
    expect(measurePlan(plan(['src/rounding/']), g).simple).toBe(false)
    expect(measurePlan(plan(['src/rounding']), g).simple).toBe(false)
    expect(final('src/rounding/round.ts', g).level).toBe('high')
    expect(await corePaths(p)).toEqual(['src/rounding', 'src/rounding/'])
  })

  test('a decision about "src/rounding" does the same', async () => {
    const p = await project()
    await addEntry(p, { kind: 'decision', text: 'Prices round down', paths: ['src/rounding'], source: 'question' })
    const g = await gateInputs(p)
    expect(measurePlan(plan(['src/rounding/round.ts']), g).simple).toBe(false)
    expect(measurePlan(plan(['src/rounding/']), g).simple).toBe(false)
    expect(final('src/rounding/round.ts', g).reasons).toEqual([strings.risk.onDecision('src/rounding/round.ts', 'Prices round down')])
  })

  test('the slashed forms keep working, and a real file path still matches only that file', async () => {
    const p = await project()
    await addEntry(p, { kind: 'core', text: 'Rounding', paths: ['src/rounding/'], source: 'person' })
    await addEntry(p, { kind: 'decision', text: 'Keep a', paths: ['src/a.ts'], source: 'question' })
    const g = await gateInputs(p)
    expect(measurePlan(plan(['src/rounding/round.ts']), g).simple).toBe(false)
    expect(final('src/rounding/round.ts', g).level).toBe('high')
    expect(final('src/a.ts', g).reasons).toEqual([strings.risk.onDecision('src/a.ts', 'Keep a')])
    expect(final('src/a.tsx', g).level).toBe('low')
    expect(final('src/a.ts.bak', g).level).toBe('low')
    expect(measurePlan(plan(['src/a.tsx']), g).simple).toBe(true)
    expect(measurePlan(plan(['src/a.ts']), g).simple).toBe(false)
  })
})

describe('a decision made on this run, by its answer', () => {
  async function runOf(p: string): Promise<string> {
    const workflowId = ulid()
    await db.insert(workflows).values({ id: workflowId, projectId: p, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
    await saveDraft(workflowId, defaultGraph())
    await publishVersion(workflowId)
    return (await createRun({ workflowId, request: 'x' })).runId
  }

  test('one that said go ahead does not stop this run; one that said do not change it does', async () => {
    const p = await project()
    const runId = await runOf(p)
    await addEntry(p, { kind: 'decision', text: 'Go', paths: ['src/a/'], source: 'question', runId })
    await addEntry(p, { kind: 'decision', text: 'Hold', paths: ['src/b/'], source: 'question', runId, outcome: 'asked_no' })
    expect((await gateInputs(p, db, runId)).decisions.map(d => d.text)).toEqual(['Hold'])
    expect((await gateInputs(p)).decisions.map(d => d.text)).toEqual(['Go', 'Hold'])
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { events, nodeRuns, projects, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { bySeverity, citeCheck, citedPath, distinctProblems, endingOf, problemGroups, latestOf, findingsOf, mergeDuplicates, recordFindings, riskOf, setFinding, DUPLICATE_WINDOW } from '@/engine/findings'
import type { Finding } from '@/engine/review'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import type { FindingRow } from '@/engine/findings'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()
const f = (over: Partial<Finding> = {}): Finding => ({ type: 'logic', problem: 'p', severity: 'medium', affects: [], decisions: [], ...over })

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-find-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  return dir
}

async function newRunForPaths() {
  const p = ulid()
  await db.insert(projects).values({ id: p, projectId: p, name: 'p', createdAt: now(), repoPath: '/repo' })
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, projectId: p, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'x' })
  const n = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))[0]!
  return { runId, nodeRunId: n.id }
}

describe('the path a finding cites', () => {
  const dir = copy()
  test('is read as the project names it: from the folder, with forward slashes and no "./"', () => {
    expect(citedPath(dir, './src/a.ts')).toBe('src/a.ts')
    expect(citedPath(dir, 'src\\a.ts')).toBe('src/a.ts')
    expect(citedPath(dir, '.\\src\\a.ts')).toBe('src/a.ts')
    expect(citedPath(dir, 'src/../src/a.ts')).toBe('src/a.ts')
    expect(citedPath(dir, `${dir}/src/a.ts`)).toBe('src/a.ts')
    expect(citedPath(dir, `${realpathSync(dir)}/src/a.ts`)).toBe('src/a.ts')
    expect(citedPath(dir, 'src/a.ts')).toBe('src/a.ts')
  })
  test('takes the letters the file has on disk, as a core area does', () => {
    // Only on a disk that does not tell letters apart can the other spelling be found at all.
    const caseBlind = readdirSync(dir).includes('src') && (() => { try { realpathSync(join(dir, 'SRC')); return true } catch { return false } })()
    if (caseBlind) expect(citedPath(dir, 'SRC/A.ts')).toBe('src/a.ts')
  })
  test('one outside the folder is kept as written, so the check refuses it', () => {
    expect(citedPath(dir, '/etc/passwd')).toBe('/etc/passwd')
    expect(citedPath(dir, '../x.ts')).toBe('../x.ts')
    expect(citeCheck(dir, f({ file: citedPath(dir, '/etc/passwd') }))).toEqual({ ok: false, reason: strings.findings.outsideCopy })
  })
  test('a path that is not plainly inside the project counts as unknown, so it is high', () => {
    for (const file of ['/abs/src/a.ts', '../a.ts', 'src\\a.ts', './src/a.ts']) {
      const r = riskOf(f({ file }), { corePaths: [] })
      expect(r.level).toBe('high')
      expect(r.reasons).toContain(strings.findings.risk.unknown)
    }
    expect(riskOf(f({ file: 'src/a.ts' }), { corePaths: [] }).level).toBe('low')
  })
  test('recorded findings keep the path as the project names it', async () => {
    const runId = await newRunForPaths()
    const rows = await recordFindings(runId.runId, runId.nodeRunId, 1, mergeDuplicates([{ focus: 'logic', finding: f({ file: `${dir}/src/a.ts`, line: 2 }) }]), dir)
    expect(rows[0]).toMatchObject({ file: 'src/a.ts', state: 'reported' })
  })
})

describe('citeCheck', () => {
  const dir = copy()
  test('a real file and line is ok', () => {
    expect(citeCheck(dir, f({ file: 'src/a.ts', line: 5 }))).toEqual({ ok: true })
  })
  test('a file with no line is checked for the file only', () => {
    expect(citeCheck(dir, f({ file: 'src/a.ts' }))).toEqual({ ok: true })
    expect(citeCheck(dir, f({ file: 'src/none.ts' }))).toEqual({ ok: false, reason: strings.findings.noSuchFile })
  })
  test('a missing file or a line past the end is refuted', () => {
    expect(citeCheck(dir, f({ file: 'src/none.ts', line: 1 }))).toEqual({ ok: false, reason: strings.findings.noSuchFile })
    expect(citeCheck(dir, f({ file: 'src/a.ts', line: 999 }))).toEqual({ ok: false, reason: strings.findings.noSuchLine })
    expect(citeCheck(dir, f({ file: 'src/a.ts', line: 0 }))).toEqual({ ok: false, reason: strings.findings.noSuchLine })
  })
  test('a path outside the copy is not read', () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'factory-out-')), 'secret.ts')
    writeFileSync(outside, 'x\n')
    expect(citeCheck(dir, f({ file: '../outside.ts', line: 1 }))).toEqual({ ok: false, reason: strings.findings.outsideCopy })
    expect(citeCheck(dir, f({ file: outside, line: 1 }))).toEqual({ ok: false, reason: strings.findings.outsideCopy })
  })
  test('a symlink pointing outside the copy is not followed', () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'factory-out-')), 'secret.ts')
    writeFileSync(outside, 'x\n')
    symlinkSync(outside, join(dir, 'src/link.ts'))
    expect(citeCheck(dir, f({ file: 'src/link.ts', line: 1 }))).toEqual({ ok: false, reason: strings.findings.outsideCopy })
  })
  test('a finding with no file has nothing to refute', () => {
    expect(citeCheck(dir, f())).toEqual({ ok: true })
  })
})

describe('mergeDuplicates', () => {
  test('same type and file within the window is one finding', () => {
    const out = mergeDuplicates([
      { focus: 'logic', finding: f({ file: 'a.ts', line: 42, problem: 'short', severity: 'low', affects: ['x'], decisions: [1] }) },
      { focus: 'security', finding: f({ file: 'a.ts', line: 40, problem: 'a longer problem text', severity: 'high', affects: ['x', 'y'], decisions: [2] }) },
    ])
    expect(DUPLICATE_WINDOW).toBe(3)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ count: 2, reporters: ['logic', 'security'] })
    expect(out[0]!.finding).toMatchObject({ line: 40, severity: 'high', problem: 'a longer problem text', affects: ['x', 'y'], decisions: [1, 2] })
  })
  test('lines too far apart stay two', () => {
    expect(mergeDuplicates([
      { focus: 'logic', finding: f({ file: 'a.ts', line: 40 }) },
      { focus: 'security', finding: f({ file: 'a.ts', line: 60 }) },
    ])).toHaveLength(2)
  })
  test('a different type on the same line stays two', () => {
    expect(mergeDuplicates([
      { focus: 'logic', finding: f({ file: 'a.ts', line: 40 }) },
      { focus: 'security', finding: f({ type: 'security', file: 'a.ts', line: 40 }) },
    ])).toHaveLength(2)
  })
})

test('bySeverity orders high, medium, low and keeps the reported order within one', () => {
  const items = [
    { severity: 'low' as const, n: 1 }, { severity: 'high' as const, n: 2 }, { severity: 'medium' as const, n: 3 }, { severity: 'high' as const, n: 4 }, { severity: 'low' as const, n: 5 },
  ]
  expect(bySeverity(items).map(i => i.n)).toEqual([2, 4, 3, 1, 5])
})

describe('riskOf', () => {
  const ctx = { corePaths: ['src/core/'] }
  test('core', () => expect(riskOf(f({ file: 'src/core/x.ts' }), ctx)).toEqual({ level: 'high', reasons: [strings.findings.risk.core] }))
  test('sensitive path', () => {
    const r = riskOf(f({ file: 'src/auth/login.ts' }), ctx)
    expect(r.level).toBe('high')
    expect(r.reasons).toEqual([strings.findings.risk.sensitive(strings.risk.areas.auth)])
  })
  test('decision', () => expect(riskOf(f({ decisions: [7] }), ctx)).toEqual({ level: 'high', reasons: [strings.findings.risk.decision('D-07')] }))
  test('security with high severity', () => expect(riskOf(f({ type: 'security', severity: 'high' }), ctx)).toEqual({ level: 'high', reasons: [strings.findings.risk.security] }))
  test('a typo in the readme is low', () => expect(riskOf(f({ file: 'README.md' }), ctx)).toEqual({ level: 'low', reasons: [] }))
  test('unknown', () => expect(riskOf(f({ file: 'README.md' }), { ...ctx, unknown: true })).toEqual({ level: 'high', reasons: [strings.findings.risk.unknown] }))
  test('all reasons, in order', () => {
    expect(riskOf(f({ type: 'security', severity: 'high', file: 'src/core/auth.ts', decisions: [1] }), { ...ctx, unknown: true }).reasons).toEqual([
      strings.findings.risk.core,
      strings.findings.risk.sensitive(strings.risk.areas.auth),
      strings.findings.risk.decision('D-01'),
      strings.findings.risk.security,
      strings.findings.risk.unknown,
    ])
  })
})

describe('recordFindings', () => {
  async function node() {
    const p = ulid()
    await db.insert(projects).values({ id: p, projectId: p, name: 'p', createdAt: now(), repoPath: '/repo' })
    const workflowId = ulid()
    await db.insert(workflows).values({ id: workflowId, projectId: p, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
    await saveDraft(workflowId, defaultGraph())
    await publishVersion(workflowId)
    const { runId } = await createRun({ workflowId, request: 'x' })
    const n = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))[0]!
    return { runId, nodeRunId: n.id, blockId: n.blockId, projectId: p }
  }

  test('refuted rows carry their reason, the rest are reported, and one event counts them', async () => {
    const { runId, nodeRunId, blockId, projectId } = await node()
    const dir = copy()
    const merged = mergeDuplicates([
      { focus: 'logic', finding: f({ file: 'src/a.ts', line: 3, decisions: [4] }) },
      { focus: 'security', finding: f({ file: 'src/a.ts', line: 4, decisions: [4] }) },
      { focus: 'logic', finding: f({ file: 'src/ghost.ts', line: 1 }) },
    ])
    const rows = await recordFindings(runId, nodeRunId, 1, merged, dir)
    expect(rows.map(r => r.state)).toEqual(['reported', 'refuted'])
    expect(rows[0]).toMatchObject({ runId, projectId, round: 1, count: 2, reporters: ['logic', 'security'], decisions: [4], repro: null, evidence: null, entryNumber: null })
    expect(rows[1]!.reason).toBe(strings.findings.noSuchFile)
    expect(await findingsOf(runId)).toEqual(rows)
    const ev = (await db.select().from(events).where(eq(events.runId, runId))).filter(e => e.type === 'node.findings_checked')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.nodeRunId).toBe(nodeRunId)
    expect(JSON.parse(ev[0]!.payloadJson)).toEqual({ blockId, round: 1, reported: 1, refuted: 1, merged: 1 })
    await setFinding(rows[0]!.id, { state: 'confirmed', reason: 'ok', entryNumber: 3 })
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'confirmed', reason: 'ok', entryNumber: 3 })
  })

  test('findings come back in the order they were recorded, even when recorded together', async () => {
    const { runId, nodeRunId } = await node()
    const dir = copy()
    // Ten findings in one call share one createdAt; only the id orders them within it, so the ids must increase.
    const merged = Array.from({ length: 10 }, (_, i) => ({ finding: f({ file: 'src/a.ts', line: i + 1 }), reporters: ['logic' as const], count: 1 }))
    const rows = await recordFindings(runId, nodeRunId, 1, merged, dir)
    expect(rows).toHaveLength(10)
    expect(rows.every(r => r.state === 'reported')).toBe(true)
    expect((await findingsOf(runId)).map(r => r.id)).toEqual(rows.map(r => r.id))
  })
})

describe('distinctProblems', () => {
  let n = 0
  const row = (over: Partial<FindingRow>): FindingRow => ({
    ...f(), id: `r${n++}`, runId: 'r', projectId: 'p', round: 1, reporters: ['logic'], count: 1, state: 'reported', reason: null, repro: null, evidence: null, entryNumber: null, ...over,
  })

  test('the same problem re-reported in a later round is one, and the latest round is the one kept', () => {
    const rows = [row({ file: 'a.ts', line: 3, round: 1, state: 'fixed_unchecked' }), row({ file: 'a.ts', line: 4, round: 2, state: 'fixed_unchecked' }), row({ file: 'a.ts', line: 3, round: 3, state: 'open' })]
    const out = distinctProblems(rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(rows[2])
  })

  test('problemGroups keeps every row of a problem; distinctProblems is the latest row of each', () => {
    const rows = [row({ file: 'a.ts', line: 3, round: 1, state: 'corrected' }), row({ file: 'b.ts', line: 1, round: 1 }), row({ file: 'a.ts', line: 3, round: 2, state: 'refuted' })]
    const groups = problemGroups(rows)
    expect(groups.map(g => g.length)).toEqual([2, 1])
    expect(groups.map(latestOf)).toEqual(distinctProblems(rows))
    expect(latestOf(groups[0]!)).toBe(rows[2])
  })

  test('a different line far away, another file or another type is another problem', () => {
    const rows = [row({ file: 'a.ts', line: 3 }), row({ file: 'a.ts', line: 3 + DUPLICATE_WINDOW + 1 }), row({ file: 'b.ts', line: 3 }), row({ file: 'a.ts', line: 3, type: 'security' })]
    expect(distinctProblems(rows)).toHaveLength(4)
  })

  test('rows without a place match on the same type and the same text', () => {
    const rows = [row({ problem: 'x', round: 1 }), row({ problem: 'x', round: 2 }), row({ problem: 'y', round: 2 }), row({ problem: 'z', file: 'a.ts', line: 1, round: 2 })]
    const out = distinctProblems(rows)
    expect(out.map(r => [r.problem, r.round, r.file ?? null])).toEqual([['x', 2, null], ['y', 2, null], ['z', 2, 'a.ts']])
  })

  test('in the same round the last recorded wins, and order of first appearance is kept', () => {
    const rows = [row({ file: 'a.ts', line: 1 }), row({ file: 'c.ts', line: 1 }), row({ file: 'a.ts', line: 2 })]
    const out = distinctProblems(rows)
    expect(out).toHaveLength(2)
    expect(out.map(r => r.id)).toEqual([rows[2]!.id, rows[1]!.id])
  })
})

describe('endingOf', () => {
  let n = 0
  const row = (over: Partial<FindingRow>): FindingRow => ({
    ...f({ file: 'a.ts', line: 3 }), id: `e${n++}`, runId: 'r', projectId: 'p', round: 1, reporters: ['logic'], count: 1, state: 'reported', reason: null, repro: null, evidence: null, entryNumber: null, ...over,
  })
  const repro = { command: 'node x.js', marker: 'MARKER-123', files: [] }
  const ends = (...rows: FindingRow[]) => endingOf(rows)

  test('fixed: the latest row is corrected', () => {
    expect(ends(row({ round: 1, state: 'confirmed' }), row({ round: 2, state: 'corrected' }))).toBe('fixed')
  })
  test('fixed: it was corrected once and the latest word is refuted, or set aside with no reproduction', () => {
    expect(ends(row({ round: 1, state: 'corrected' }), row({ round: 2, state: 'refuted' }))).toBe('fixed')
    expect(ends(row({ round: 1, state: 'corrected' }), row({ round: 2, state: 'discarded' }))).toBe('fixed')
  })
  test('not fixed: set aside after being shown to happen is a problem left by choice', () => {
    expect(ends(row({ round: 1, state: 'corrected' }), row({ round: 2, state: 'discarded', repro }))).toBe('set_aside')
  })
  test('needs you: open, asked, or fixed and not checked', () => {
    for (const state of ['open', 'asked', 'fixed_unchecked'] as const) expect(ends(row({ state }))).toBe('needs_you')
  })
  test('needs you wins when the fix did not hold', () => {
    expect(ends(row({ round: 1, state: 'corrected' }), row({ round: 2, state: 'open' }))).toBe('needs_you')
  })
  test('set aside: refuted or discarded and never fixed', () => {
    expect(ends(row({ state: 'refuted' }))).toBe('set_aside')
    expect(ends(row({ state: 'discarded' }))).toBe('set_aside')
  })
  test('still being worked on: reported, confirmed, unbacked', () => {
    for (const state of ['reported', 'confirmed', 'unbacked'] as const) expect(ends(row({ state }))).toBe('in_progress')
  })
})

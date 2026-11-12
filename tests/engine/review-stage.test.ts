import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, questions, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { findingsOf, needsPerson, type FindingRow } from '@/engine/findings'
import { MAX_FINDINGS } from '@/engine/review'
import { addEntry, listRegister } from '@/engine/register'
import { answerQuestion, LEAVE, openQuestion, OTHER } from '@/engine/questions'
import type { Repro, ReproRun } from '@/engine/repro'
import { orchestrateRun, type ExecutorDeps, type StepApi } from '@/engine/inngest/execute-run'
import { cancelRun, createRun, publishVersion, saveDraft } from '@/engine/run'
import { recordDecision } from '@/engine/approvals'
import type { Finding, Focus } from '@/engine/review'
import type { StageResult } from '@/engine/inngest/review-stage'
import { MAX_FIX_ATTEMPTS } from '@/engine/tree-snapshot'
import { createDemoProvider } from '@/providers/demo'
import type { AgentEvent, AgentProvider } from '@/providers/types'
import { strings } from '@/ui/strings'

// The Review block reads the change with one reviewer or three, and checks what they found before the builder sees it.

// What each pass through the Review stage returned, for the one thing the events do not show (`fixesSince`).
const stageResults: StageResult[] = []
vi.mock('@/engine/inngest/review-stage', async importOriginal => {
  const real = await importOriginal<typeof import('@/engine/inngest/review-stage')>()
  return { ...real, runReviewStage: async (ctx: Parameters<typeof real.runReviewStage>[0]) => { const r = await real.runReviewStage(ctx); stageResults.push(r); return r } }
})

// Everything the tests create on disk is removed afterwards.
const temps: string[] = []
afterAll(() => temps.forEach(t => rmSync(t, { recursive: true, force: true })))
const track = (dir: string): string => {
  temps.push(dir)
  return dir
}

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

class Parked extends Error {}
// Like Inngest: a step that finished is not run again, its stored result is handed back. Every id asked for is kept.
function recordingStep(onWait: () => Promise<{ data: Record<string, never> } | null> = async () => {
  throw new Parked()
}): StepApi & { ids: string[]; onWait: typeof onWait; forget: (id: string) => void } {
  const ids: string[] = []
  const done = new Map<string, unknown>()
  const self = {
    ids,
    onWait,
    forget: (id: string) => void done.delete(id),
    run: async <T,>(id: string, fn: () => Promise<T> | T): Promise<T> => {
      ids.push(id)
      if (done.has(id)) return JSON.parse(JSON.stringify(done.get(id)))
      const result = JSON.parse(JSON.stringify((await fn()) ?? null))
      done.set(id, result)
      return result
    },
    waitForEvent: async (id: string) => {
      ids.push(id)
      return self.onWait()
    },
  }
  return self
}

async function newRun(tweak?: (g: ReturnType<typeof defaultGraph>) => void): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: '/repo' })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  const graph = defaultGraph()
  tweak?.(graph)
  await saveDraft(workflowId, graph)
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'do it' })
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  return runId
}

/** A folder with a.tsx in it. `git` makes it a repository whose one commit is the base, with a small change on top. */
function workdir(git: boolean): { dir: string; base: string } {
  const dir = track(mkdtempSync(join(tmpdir(), 'factory-review-')))
  writeFileSync(join(dir, 'a.tsx'), 'one\ntwo\nthree\nfour\nfive\n')
  if (!git) return { dir, base: 'abc' }
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  run('init', '-q')
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base')
  run('add', '.')
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'files')
  const base = run('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.tsx'), 'one\ntwo\nthree!\nfour\nfive\n')
  return { dir, base }
}

const finding = (over: Partial<Finding> = {}): Finding => ({ type: 'logic', file: 'a.tsx', line: 3, problem: 'wrong colour', severity: 'medium', affects: [], decisions: [], ...over })
const passingTests: AgentEvent = {
  type: 'evidence',
  kind: 'test_run',
  data: { command: 'npm test', exitCode: 0, signal: null, started: true, durationMs: 5, counts: null, outputTail: '', changedTestFiles: [] },
}

type Reply = (focus: Focus, round: number) => AgentEvent[]
function reviewers(reply: Reply) {
  const seen: { kind: string; focus?: Focus; note?: string }[] = []
  const asked: Focus[] = []
  const provider: AgentProvider = {
    id: 'files',
    isDemo: false,
    needsWorkspace: true,
    async *execute(input) {
      seen.push({ kind: input.blockKind, focus: input.focus, note: input.revisionNote })
      if (input.blockKind === 'tests') yield passingTests
      if (input.role === 'verifier') {
        yield { type: 'done', summary: 'could not', source: 'provider', repro: null }
        return
      }
      if (input.blockKind === 'review') {
        asked.push(input.focus!)
        const round = seen.filter(s => s.kind === 'build').length
        for (const ev of reply(input.focus!, round)) yield ev
        return
      }
      yield { type: 'done', summary: input.blockKind === 'build' ? 'built it' : 'ok', source: 'system' }
    },
  }
  return { provider, seen, asked }
}
const says = (...findings: Finding[]): AgentEvent[] => [
  { type: 'done', summary: 's', source: 'provider', review: findings.length ? { verdict: 'changes', findings } : { verdict: 'ok', findings: [] } },
]

async function drive(runId: string, provider: AgentProvider, dir: string, base: string, step: StepApi = recordingStep(), deps: Partial<ExecutorDeps> = {}) {
  try {
    await orchestrateRun(runId, step, { resolveProvider: () => provider, createWorktree: () => ({ path: dir, branch: 'b', baseCommit: base }), ...deps })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
}
const node = async (runId: string, blockId: string) => (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === blockId)!
const payloads = async (runId: string, type: string, blockId: string) =>
  (await eventsSince(runId, 0)).filter(e => e.type === type && (e.payload as { blockId?: string }).blockId === blockId).map(e => e.payload as Record<string, unknown>)

describe('how many reviewers read the change', () => {
  test('a change that measures high risk is read by three, each in a step of its own', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false) // not a repository: it cannot be measured, so it counts as high
    const { provider, asked } = reviewers(() => says())
    const step = recordingStep()
    await drive(runId, provider, dir, base, step)
    const ids = step.ids
    expect(asked).toEqual(['logic', 'security', 'effects'])
    for (const f of ['logic', 'security', 'effects']) expect(ids).toContain(`review-review-${f}`)
    const steps = (await payloads(runId, 'node.step', 'review')).map(p => p.text)
    expect(steps).toContain(strings.review.depth.three)
    expect((await payloads(runId, 'node.reviewed', 'review')).map(p => p.focus)).toEqual(['logic', 'security', 'effects'])
    expect(await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).then(rs => rs.filter(r => r.blockId === 'review'))).toHaveLength(1)
  })

  test('a small change that measures low is read by one', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const { provider, asked } = reviewers(() => says())
    const step = recordingStep()
    await drive(runId, provider, dir, base, step)
    const ids = step.ids
    expect(asked).toEqual(['logic'])
    expect(ids).not.toContain('review-review-security')
    const steps = (await payloads(runId, 'node.step', 'review')).map(p => p.text)
    expect(steps).toContain(strings.review.depth.one)
  })

  test('the same small change inside a core area the person marked is read by three', async () => {
    const runId = await newRun()
    await addEntry(await projectOf(runId), { kind: 'core', text: 'Ask me before changing a.tsx', paths: ['a.tsx'], source: 'person' })
    const { dir, base } = workdir(true)
    const { provider, asked } = reviewers(() => says())
    await drive(runId, provider, dir, base, recordingStep())
    expect(asked).toEqual(['logic', 'security', 'effects'])
  })
})

describe('what the reviewers found', () => {
  test('a line two reviewers reported is one finding, and the builder is not run again for it', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider, seen } = reviewers((focus, round) => (round === 1 && focus !== 'effects' ? says(finding({ line: focus === 'logic' ? 3 : 4 })) : says()))
    await drive(runId, provider, dir, base)
    expect(seen.filter(s => s.kind === 'build')).toHaveLength(1)
    expect((await eventsSince(runId, 0)).some(e => e.type === 'node.reopened')).toBe(false)
    const rows = await findingsOf(runId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reporters: ['logic', 'security'], count: 2 })
  })

  test('a finding that points at a missing file is never checked or fixed, and is kept as refuted', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider, seen } = reviewers(focus => (focus === 'logic' ? says(finding({ file: 'ghost.tsx' })) : says()))
    await drive(runId, provider, dir, base)
    expect(seen.filter(s => s.kind === 'build')).toHaveLength(1)
    expect((await findingsOf(runId)).find(r => r.file === 'ghost.tsx')!.state).toBe('refuted')
  })

  test('when every finding is refuted the block passes', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider, seen } = reviewers(focus => (focus === 'logic' ? says(finding({ file: 'ghost.tsx' })) : says()))
    await drive(runId, provider, dir, base)
    expect(seen.filter(s => s.kind === 'build')).toHaveLength(1)
    expect((await node(runId, 'review')).state).toBe('passed')
    expect((await node(runId, 'review')).summary).toBe(strings.review.noneWasReal(1))
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['refuted'])
    expect((await eventsSince(runId, 0)).some(e => e.type === 'node.reopened')).toBe(false)
  })

  test('when the checker could not show any report to be real, the card does not say the reviewers found problems', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider } = reviewers(focus => (focus === 'logic' ? says(finding({ line: 1 }), finding({ line: 5, problem: 'other' })) : says()))
    await drive(runId, provider, dir, base)
    const summary = (await node(runId, 'review')).summary
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['discarded', 'discarded'])
    expect(summary).toBe(strings.review.noneWasReal(2))
    expect(summary).not.toMatch(/found/)
  })

  test('a reviewer that changed a file fails the block, and no reviewer\'s findings are used', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider, seen } = reviewers(focus =>
      focus === 'security' ? [{ type: 'error', source: 'system', message: strings.review.reviewerChangedFiles }] : says(finding()),
    )
    await drive(runId, provider, dir, base)
    expect((await node(runId, 'review')).state).toBe('failed')
    expect(await findingsOf(runId)).toEqual([])
    expect(seen.filter(s => s.kind === 'build')).toHaveLength(1)
    expect((await eventsSince(runId, 0)).some(e => e.type === 'node.findings_checked')).toBe(false)
  })
})

describe('Approve sums up the findings', () => {
  test('the sentence reads plainly and leaves out what is zero', () => {
    expect(strings.review.approve.summary({ found: 3, fixed: 2, discarded: 0, needsYou: 1 })).toBe('3 problems found. 2 fixed, 1 needs you.')
    expect(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 1, needsYou: 0 })).toBe('1 problem found. 1 set aside.')
  })
})

describe('a round is recorded once', () => {
  test('no step id is used twice, and the round records its findings once', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider } = reviewers(focus => (focus === 'logic' ? says(finding()) : says()))
    const step = recordingStep()
    await drive(runId, provider, dir, base, step)
    expect(new Set(step.ids).size).toBe(step.ids.length)
    const checked = (await eventsSince(runId, 0)).filter(e => e.type === 'node.findings_checked').map(e => (e.payload as { round: number }).round)
    expect(checked).toEqual([1])
  })

  test('running the same run again with the same finished steps adds no events, findings or register lines', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider } = reviewers(focus => (focus === 'logic' ? says(finding()) : says()))
    const step = recordingStep()
    await drive(runId, provider, dir, base, step)
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    const before = { events: (await eventsSince(runId, 0)).length, findings: (await findingsOf(runId)).length, register: (await listRegister(projectId)).length }
    await drive(runId, provider, dir, base, step)
    expect({ events: (await eventsSince(runId, 0)).length, findings: (await findingsOf(runId)).length, register: (await listRegister(projectId)).length }).toEqual(before)
  })
})

// ---- verify each finding, then fix it or ask --------------------------------------------------------------------

const repro: Repro = { command: 'node check.js', marker: 'PROBLEM-SEEN', files: [{ path: 'check.js', content: 'console.log("PROBLEM-SEEN"); process.exit(1)' }] }
const seenRun = (over: Partial<ReproRun> = {}): ReproRun => ({ exitCode: 1, markerSeen: true, outputTail: 'PROBLEM-SEEN', at: now(), ...over })

type Script = {
  /** Findings the logic reviewer reports on the first review. */
  found: Finding[]
  /** What the logic reviewer reports on the n-th review of the run (2 and up). Default: nothing. */
  later?: (pass: number) => Finding[]
  /** Runs inside the n-th Tests block (1-based). Returned events replace the passing result. */
  duringTests?: (n: number) => Promise<AgentEvent[] | void> | AgentEvent[] | void
  /** What the verifier answers for a finding (by its problem text). Default: it reproduced it. */
  verify?: (problem: string) => AgentEvent[]
  /** What the app's own run of the reproduction shows. Default: the problem happened. */
  repro?: (problem: string) => ReproRun
  /** The fixer ends in an error instead of a fix. */
  fixerFails?: boolean
  /** What the fixer does to the task's folder, on its n-th call (1-based). */
  fix?: (dir: string, n: number) => void | Promise<void>
  /** What the app's run of the reproduction shows after the n-th fixer call. Default: the problem is gone. */
  after?: (n: number) => ReproRun
  /** Runs inside the verifier call, before it answers (to cancel the run while it works). */
  duringVerify?: () => Promise<void>
}
const reproduces = (): AgentEvent[] => [{ type: 'done', summary: 'v', source: 'provider', repro }]

function scripted(script: Script) {
  const calls: { role?: string; workdir?: string; problem?: string; repro?: Repro; kind: string; focus?: Focus; since?: { paths: string[]; diff: string; more?: number } }[] = []
  const copies: string[] = []
  const reproRuns: string[] = []
  const provider: AgentProvider = {
    id: 'files',
    isDemo: false,
    needsWorkspace: true,
    async *execute(input) {
      calls.push({ role: input.role, workdir: input.workdir, problem: input.finding?.problem, repro: input.repro, kind: input.blockKind, focus: input.focus, since: input.reviewSince })
      if (input.role === 'verifier') {
        await script.duringVerify?.()
        for (const ev of (script.verify ?? reproduces)(input.finding!.problem)) yield ev
        return
      }
      if (input.role === 'fixer') {
        await script.fix?.(input.workdir!, calls.filter(c => c.role === 'fixer').length)
        if (script.fixerFails) yield { type: 'error', message: 'could not', source: 'provider' }
        else yield { type: 'done', summary: 'fixed', source: 'provider' }
        return
      }
      if (input.blockKind === 'tests') {
        const replaced = await script.duringTests?.(calls.filter(c => c.kind === 'tests').length)
        for (const ev of replaced ?? [passingTests]) yield ev
        if (replaced) return
      }
      if (input.blockKind === 'review') {
        const pass = calls.filter(c => c.kind === 'review' && c.focus === 'logic').length
        for (const ev of input.focus === 'logic' ? says(...(pass === 1 ? script.found : (script.later?.(pass) ?? []))) : says()) yield ev
        return
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  const deps: Partial<ExecutorDeps> = {
    snapshotStore: track(mkdtempSync(join(tmpdir(), 'factory-store-'))),
    makeCopy: async () => {
      const c = track(mkdtempSync(join(tmpdir(), 'factory-copy-')))
      copies.push(c)
      return c
    },
    runRepro: async (r, wd) => {
      reproRuns.push(wd)
      expect(r).toEqual(repro)
      // The first run of a finding is the verification; one that comes right after a fixer call is the check of that fix.
      if (calls.at(-1)?.role === 'fixer') return (script.after ?? (() => seenRun({ exitCode: 0, markerSeen: false, outputTail: '' })))(calls.filter(c => c.role === 'fixer').length)
      return (script.repro ?? (() => seenRun()))(calls.filter(c => c.role === 'verifier').at(-1)!.problem!)
    },
  }
  return { provider, deps, calls, copies, reproRuns }
}
const send = async () => {}
const projectOf = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
const withCore = async (runId: string) => addEntry(await projectOf(runId), { kind: 'core', text: 'Money code', paths: ['a.tsx'], source: 'test' })
/** The steps of one finding that has been asked about and fixed. */
const stepsOf = (row: FindingRow) => [`verify-${row.id}`, `ask-${row.id}`, `snap-${row.id}`, `before-${row.id}`, `fix-${row.id}-1`, `check-${row.id}-1`, `resolve-${row.id}`]
const counts = async (runId: string) => ({
  register: (await listRegister(await projectOf(runId))).filter(e => e.kind === 'finding').length,
  resolved: (await eventsSince(runId, 0)).filter(e => e.type === 'node.finding_resolved').length,
  questions: (await questionRows(runId)).length,
})
const questionRows = (runId: string) => db.select().from(questions).where(eq(questions.runId, runId))

describe('a finding is verified, then fixed or asked about', () => {
  test('a reproduced small problem goes to the fixer; nothing is asked and the verifier never works in the task', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const verifier = s.calls.filter(c => c.role === 'verifier')
    const fixer = s.calls.filter(c => c.role === 'fixer')
    expect(verifier).toHaveLength(1)
    expect(verifier[0]!.workdir).toBe(s.copies[0])
    expect(verifier[0]!.workdir).not.toBe(dir)
    expect(s.reproRuns).toEqual([dir, dir]) // the app runs the repro itself, from the task's folder (which it copies): once to see the problem, once to check the fix
    expect(s.copies.every(c => !existsSync(c))).toBe(true)
    expect(fixer).toHaveLength(1)
    expect(fixer[0]).toMatchObject({ workdir: dir, problem: 'wrong colour', repro })
    expect(await questionRows(runId)).toHaveLength(0)
    const [row] = await findingsOf(runId)
    expect(row).toMatchObject({ state: 'corrected', evidence: { exitCode: 0, markerSeen: false } })
    expect(row!.entryNumber).not.toBeNull()
    expect((await node(runId, 'review')).state).toBe('passed')
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    const line = (await listRegister(projectId)).find(e => e.kind === 'finding')!
    expect(line).toMatchObject({ number: row!.entryNumber, outcome: 'done', runId, paths: ['a.tsx'] })
    expect(await payloads(runId, 'node.finding_resolved', 'review')).toEqual([{ blockId: 'review', findingId: row!.id, state: 'corrected', outcome: 'done' }])
    // Nothing goes back to Build; the fix is followed by one more look, in which nothing is found.
    expect((await eventsSince(runId, 0)).some(e => e.type === 'node.reopened' && (e.payload as { blockId?: string }).blockId === 'build')).toBe(false)
    const approve = await payloads(runId, 'node.completed', 'approve')
    // The check that showed the problem now passes: it counts as fixed, and nothing is left for the person.
    expect(approve.at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 1, discarded: 0, needsYou: 0 }))
  })

  test('a reproduced problem in a core area parks the run with one question; "leave it" discards it with the person\'s reason', async () => {
    const runId = await newRun()
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    await addEntry(projectId, { kind: 'core', text: 'Money code', paths: ['a.tsx'], source: 'test' })
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding({ decisions: [7] })] })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    const open = (await openQuestion(runId))!
    expect(open).toMatchObject({ kind: 'finding', touches: [7], recommended: 'fix' })
    expect(open.options.map(o => o.id)).toEqual(['fix', LEAVE])
    expect(open.text).not.toContain('a.tsx')
    expect(await questionRows(runId)).toHaveLength(1)
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
    expect((await node(runId, 'approve')).state).toBe('queued')

    await answerQuestion(open.id, { option: LEAVE, text: 'not now' }, { send })
    step.onWait = async () => ({ data: {} })
    await drive(runId, s.provider, dir, base, step, s.deps)
    const [row] = await findingsOf(runId)
    expect(row).toMatchObject({ state: 'discarded', reason: 'not now' })
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
    const register = await listRegister(projectId)
    expect(register.filter(e => e.kind === 'decision')).toHaveLength(1)
    expect(register.find(e => e.kind === 'finding')).toMatchObject({ number: row!.entryNumber, outcome: 'asked_no', reason: 'not now' })
    expect((await node(runId, 'review')).state).toBe('passed')
    expect((await node(runId, 'approve')).state).toBe('passed')
  })

  test('"Fix it" sends the problem to the fixer and is recorded as asked_yes; the person\'s own words leave it open without a fixer', async () => {
    for (const choice of ['fix', OTHER]) {
      const runId = await newRun()
      const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
      await addEntry(projectId, { kind: 'core', text: 'Money code', paths: ['a.tsx'], source: 'test' })
      const { dir, base } = workdir(true)
      const s = scripted({ found: [finding()] })
      const step = recordingStep(async () => {
        const q = await openQuestion(runId)
        if (!q) throw new Parked() // the human gate's wait, later on
        await answerQuestion(q.id, { option: choice, text: 'do it differently' }, { send })
        return { data: {} }
      })
      await drive(runId, s.provider, dir, base, step, s.deps)
      const [row] = await findingsOf(runId)
      const line = (await listRegister(projectId)).find(e => e.kind === 'finding')!
      if (choice === 'fix') {
        expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(1)
        expect(row!.state).toBe('corrected')
        expect(line.outcome).toBe('asked_yes')
      } else {
        expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
        expect(row).toMatchObject({ state: 'open', reason: 'do it differently' })
        expect(line.outcome).toBe('open')
      }
      expect(new Set(step.ids).size).toBe(step.ids.length)
    }
  })

  test('a project with no way to reproduce: a medium problem is discarded as not reproduced', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding({ problem: 'medium one' })], repro: () => seenRun({ exitCode: null, markerSeen: false, outputTail: '' }) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const [row] = await findingsOf(runId)
    expect(row).toMatchObject({ state: 'discarded', reason: strings.findings.notReproduced })
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
    expect(await questionRows(runId)).toHaveLength(0)
  })

  test('a project with no way to reproduce: a high problem asks, saying it could not be checked', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding({ problem: 'high one', severity: 'high' })], repro: () => seenRun({ exitCode: null, markerSeen: false, outputTail: '' }) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const [row] = await findingsOf(runId)
    expect(row!.state).toBe('asked')
    const open = (await openQuestion(runId))!
    expect(open.why).toContain(strings.findings.risk.unknown)
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
  })

  test('a verifier that errors leaves a medium problem discarded as not reproduced', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding()], verify: () => [{ type: 'error', message: 'boom', source: 'provider' }] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'discarded', reason: strings.findings.notReproduced })
    expect(s.reproRuns).toEqual([])
  })

  test('a verifier that gives no usable repro: the person sees the same sentence, the event log says why for a developer', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const noRepro = { why: 'unsafe_path' as const, answer: '{"reproduced":true,"files":["/tmp/r.mjs"]}' }
    const s = scripted({ found: [finding({ severity: 'high' })], verify: () => [{ type: 'done', summary: 'v', source: 'provider', repro: null, noRepro }] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const row = (await findingsOf(runId))[0]!
    expect(row).toMatchObject({ reason: strings.findings.notReproduced })
    expect(s.reproRuns).toEqual([])
    const checked = (await eventsSince(runId, 0)).filter(e => e.type === 'node.finding_checked').map(e => e.payload)
    expect(checked).toEqual([expect.objectContaining({ findingId: row.id, verdict: 'unbacked', why: 'unsafe_path', answer: noRepro.answer })])
  })

  test('every other way a check ends without proof says why in the event log too', async () => {
    const whys = async (script: Partial<Script>, change?: (deps: Partial<ExecutorDeps>) => void) => {
      const runId = await newRun()
      const { dir, base } = workdir(false)
      const s = scripted({ found: [finding()], ...script })
      change?.(s.deps)
      await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
      return (await eventsSince(runId, 0)).filter(e => e.type === 'node.finding_checked').map(e => (e.payload as { why: string }).why)
    }
    expect(await whys({ verify: () => [{ type: 'error', message: 'boom', source: 'provider' }] })).toEqual(['verifier_error'])
    expect(await whys({ verify: () => [{ type: 'done', summary: 'v', source: 'provider', repro: null }] })).toEqual(['no_repro'])
    expect(await whys({ repro: () => seenRun({ exitCode: 0 }) })).toEqual(['app_run_not_reproduced'])
    expect(await whys({}, d => { d.makeCopy = async () => { throw new Error('no copy') } })).toEqual(['copy_failed'])
    // A refuted or a reproduced finding is not a check that ended without proof.
    expect(await whys({ verify: () => [{ type: 'done', summary: 'r', source: 'provider', repro: null, refuted: { why: 'fine' } }] })).toEqual([])
    expect(await whys({})).toEqual([])
  })

  test('a copy that cannot be made leaves a high problem unbacked, saying the check could not be run, and asks', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding({ severity: 'high' })] })
    s.deps.makeCopy = async () => {
      throw new Error('no copy')
    }
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(s.calls.some(c => c.role === 'verifier')).toBe(false)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'asked', reason: strings.findings.checkNotRun })
    expect(await openQuestion(runId)).not.toBeNull()
  })

  test('the verifier saying the code does not do it refutes the finding: no fixer, no builder, reason kept', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding()], verify: () => [{ type: 'done', summary: 'r', source: 'provider', repro: null, refuted: { why: 'the colour is set one line up' } }] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const [row] = await findingsOf(runId)
    expect(row).toMatchObject({ state: 'refuted', reason: 'the colour is set one line up' })
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    expect((await listRegister(projectId)).find(e => e.kind === 'finding')).toMatchObject({ outcome: 'discarded', reason: 'the colour is set one line up' })
  })

  test('the wait running out leaves the run waiting and resolves nothing', async () => {
    const runId = await newRun()
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    await addEntry(projectId, { kind: 'core', text: 'Money code', paths: ['a.tsx'], source: 'test' })
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding()] })
    await drive(runId, s.provider, dir, base, recordingStep(async () => null), s.deps)
    expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('waiting_approval')
    const [row] = await findingsOf(runId)
    expect(row).toMatchObject({ state: 'asked', entryNumber: null })
    expect((await listRegister(projectId)).some(e => e.kind === 'finding')).toBe(false)
    expect((await node(runId, 'approve')).state).toBe('queued')
  })

  test('more than MAX_FINDINGS: only the most severe are verified, the rest are discarded as too many and counted as needing the person', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const found = Array.from({ length: MAX_FINDINGS + 2 }, (_, i) => finding({ file: undefined, line: undefined, problem: `problem ${i}`, severity: i < 2 ? 'low' : 'medium' }))
    const s = scripted({ found, verify: () => [{ type: 'done', summary: 'v', source: 'provider', repro: null }] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(s.calls.filter(c => c.role === 'verifier')).toHaveLength(MAX_FINDINGS)
    const rows = await findingsOf(runId)
    expect(rows.filter(r => r.reason === strings.findings.tooMany).map(r => r.problem)).toEqual(['problem 0', 'problem 1'])
    expect(rows.filter(r => r.reason === strings.findings.tooMany).every(r => r.entryNumber !== null && r.state === 'open')).toBe(true)
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    expect((await listRegister(projectId)).filter(e => e.reason === strings.findings.tooMany).map(e => e.outcome)).toEqual(['open', 'open'])
    const approve = await payloads(runId, 'node.completed', 'approve')
    expect(approve.at(-1)!.summary).toBe(strings.review.approve.summary({ found: MAX_FINDINGS + 2, fixed: 0, discarded: MAX_FINDINGS, needsYou: 2 }))
  })

  test('several findings and a question: no step id is used twice, and a retried step writes nothing twice', async () => {
    const runId = await newRun()
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    await addEntry(projectId, { kind: 'core', text: 'Money code', paths: ['b.tsx'], source: 'test' })
    const { dir, base } = workdir(true)
    writeFileSync(join(dir, 'b.tsx'), 'x\ny\n')
    const s = scripted({
      found: [finding({ problem: 'small', line: 1 }), finding({ problem: 'core', file: 'b.tsx', line: 1 }), finding({ problem: 'gone', line: 5 })],
      verify: p => (p === 'gone' ? [{ type: 'done', summary: 'r', source: 'provider', repro: null, refuted: { why: 'fine' } }] : reproduces()),
    })
    const step = recordingStep(async () => {
      const q = await openQuestion(runId)
      if (!q) throw new Parked()
      await answerQuestion(q.id, { option: 'fix' }, { send })
      return { data: {} }
    })
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(new Set(step.ids).size).toBe(step.ids.length)
    for (const row of await findingsOf(runId)) {
      expect(step.ids).toContain(`verify-${row.id}`)
      expect(step.ids).toContain(`resolve-${row.id}`)
    }
    const before = { events: (await eventsSince(runId, 0)).length, register: (await listRegister(projectId)).length }
    await drive(runId, s.provider, dir, base, step, s.deps) // everything memoised: nothing happens again
    expect({ events: (await eventsSince(runId, 0)).length, register: (await listRegister(projectId)).length }).toEqual(before)
    expect((await listRegister(projectId)).filter(e => e.kind === 'finding')).toHaveLength(3)
  })
})

describe('the question is in the app\'s own words', () => {
  const technical = '`parseAmount` in src/pay/x.ts:42 returns NaN'
  for (const [type, said] of [['logic', 'may not do what you asked'], ['security', 'may not be safe'], ['effect', 'may break something else']] as const) {
    test(`a ${type} problem is described by its kind, not by the reviewer's text`, async () => {
      const runId = await newRun()
      await withCore(runId)
      const { dir, base } = workdir(false)
      const s = scripted({ found: [finding({ type, problem: technical, decisions: [7] })] })
      await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
      const q = (await openQuestion(runId))!
      expect(q.text).toContain(said)
      expect(q.text).toContain('saw the problem happen')
      for (const secret of ['parseAmount', 'src/pay', 'x.ts', 'a.tsx', 'NaN']) {
        expect(q.text).not.toContain(secret)
        expect(q.why).not.toContain(secret)
      }
      expect(q.detail).toContain('parseAmount')
      expect(q.detail).toContain('a.tsx:3')
    })
  }

  test('a problem that could not be made to happen says so', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding({ severity: 'high', problem: technical })], verify: () => [{ type: 'done', summary: 'v', source: 'provider', repro: null }] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const q = (await openQuestion(runId))!
    expect(q.text).toContain('could not make the problem happen')
    expect(q.text).not.toContain('parseAmount')
  })

  test('what the reviewer said is redacted before it is kept', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding({ problem: 'the key is API_TOKEN=sk-abcdefghijklmnopqrstuvwx in the file' })] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await openQuestion(runId))!.detail).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })
})

describe('what still needs the person holds the gate', () => {
  const row = (state: FindingRow['state']) => ({ state }) as FindingRow
  test('needsPerson is one definition', () => {
    expect((['open', 'asked', 'fixed_unchecked'] as const).map(st => needsPerson(row(st)))).toEqual([true, true, true])
    expect((['reported', 'refuted', 'unbacked', 'confirmed', 'corrected', 'discarded'] as const).map(st => needsPerson(row(st)))).toEqual([false, false, false, false, false, false])
  })

  const FIX_IT = async (runId: string) => {
    const q = await openQuestion(runId)
    if (!q) throw new Parked() // the human gate's wait
    await answerQuestion(q.id, { option: 'fix' }, { send })
    return { data: {} }
  }
  async function lowRiskRun(found: Finding[], over: Partial<Script> = {}, answer?: (runId: string) => Promise<{ data: Record<string, never> }>) {
    const runId = await newRun()
    const projectId = await projectOf(runId)
    await db.update(projects).set({ autoApproveLowRisk: true, testCommand: 'npm test' }).where(eq(projects.id, projectId))
    const { dir, base } = workdir(true)
    const s = scripted({ found, ...over })
    await drive(runId, s.provider, dir, base, recordingStep(answer ? () => answer(runId) : undefined), s.deps)
    return runId
  }

  test('with auto-approve on, a clean small change passes the human check by itself', async () => {
    const runId = await lowRiskRun([])
    expect((await node(runId, 'human')).state).toBe('passed')
  })

  test('with auto-approve on, a fix the check confirmed passes the human check by itself', async () => {
    const runId = await lowRiskRun([finding()])
    expect((await findingsOf(runId))[0]!.state).toBe('corrected')
    expect((await node(runId, 'human')).state).toBe('passed')
  })

  test('with auto-approve on, a fix that did not solve it does not', async () => {
    const runId = await lowRiskRun([finding()], { after: () => seenRun() })
    expect((await findingsOf(runId))[0]!.state).toBe('open')
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
  })

  test('with auto-approve on, a fix nobody could check does not', async () => {
    const runId = await lowRiskRun([finding({ severity: 'high' })], { verify: () => [{ type: 'done', summary: 'v', source: 'provider', repro: null }] }, FIX_IT)
    expect((await findingsOf(runId))[0]!.state).toBe('fixed_unchecked')
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
  })

  test('with auto-approve on, a finding that was not checked for being too many does not', async () => {
    const found = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => finding({ file: undefined, line: undefined, problem: `p${i}`, severity: i === 0 ? 'low' : 'medium' }))
    const runId = await newRun()
    const projectId = await projectOf(runId)
    await db.update(projects).set({ autoApproveLowRisk: true, testCommand: 'npm test' }).where(eq(projects.id, projectId))
    const { dir, base } = workdir(true)
    const s = scripted({ found, verify: () => [{ type: 'done', summary: 'v', source: 'provider', repro: null }] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId)).filter(r => r.state === 'open')).toHaveLength(1)
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
  })
})

describe('a step that runs again writes nothing twice', () => {
  for (const prefix of ['verify-', 'ask-', 'snap-', 'before-', 'fix-', 'check-', 'resolve-'] as const) {
    test(`${prefix}<finding> forgotten and run again`, async () => {
      const runId = await newRun()
      await withCore(runId)
      const { dir, base } = workdir(true)
      const s = scripted({ found: [finding()] })
      const step = recordingStep(async () => {
        const q = await openQuestion(runId)
        if (!q) throw new Parked() // the human gate's wait
        await answerQuestion(q.id, { option: 'fix' }, { send })
        return { data: {} }
      })
      await drive(runId, s.provider, dir, base, step, s.deps)
      const [row] = await findingsOf(runId)
      const before = await counts(runId)
      const verifiers = s.calls.filter(c => c.role === 'verifier').length
      const fixers = s.calls.filter(c => c.role === 'fixer').length
      expect(before).toEqual({ register: 1, resolved: 1, questions: 1 })
      step.forget(stepsOf(row!).find(id => id.startsWith(prefix))!)
      await drive(runId, s.provider, dir, base, step, s.deps)
      expect(await counts(runId)).toEqual(before)
      expect(s.calls.filter(c => c.role === 'verifier').length).toBe(verifiers)
      // The fix- guard sees the committed state and makes no second call. Only a crash before that state is written can still
      // call the fixer twice (Task 8 closes it); the records are never doubled either way.
      expect(s.calls.filter(c => c.role === 'fixer').length).toBe(fixers)
      expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected', entryNumber: row!.entryNumber })
    })
  }

  test('a person who answered before the step ran: the answered question is found again and the finding resolves without waiting', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding()] })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    const [row] = await findingsOf(runId)
    await answerQuestion((await openQuestion(runId))!.id, { option: LEAVE, text: 'no' }, { send })
    step.forget(`ask-${row!.id}`)
    step.ids.length = 0
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(step.ids.some(id => id.startsWith(`question-${row!.id}`))).toBe(false)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'discarded', reason: 'no' })
    expect((await counts(runId)).questions).toBe(1)
  })

  test('an event that is not an answer to this question resolves nothing', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding()] })
    let woken = 0
    const step = recordingStep(async () => {
      if (woken++ === 0) return { data: {} } // an event for some other question: no answer is recorded
      throw new Parked()
    })
    await drive(runId, s.provider, dir, base, step, s.deps)
    const [row] = await findingsOf(runId)
    expect(row).toMatchObject({ state: 'asked', entryNumber: null })
    expect(step.ids).toContain(`question-${row!.id}-0`)
    expect(step.ids).toContain(`question-${row!.id}-1`)
    expect(await openQuestion(runId)).not.toBeNull()
  })
})

describe('cancelling and failing', () => {
  test('cancelled while a verifier works: its copy is removed and nothing is written after', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({
      found: [finding()],
      duringVerify: async () => {
        await cancelRun(runId)
        await new Promise(r => setTimeout(r, 400)) // the run notices the cancel while the verifier is still going
      },
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(s.copies.every(c => !existsSync(c))).toBe(true)
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'reported', entryNumber: null })
    const all = await eventsSince(runId, 0)
    const cancelled = all.findIndex(e => e.type === 'run.cancelled')
    expect(cancelled).toBeGreaterThan(-1)
    expect(all.slice(cancelled).some(e => ['node.finding_resolved', 'node.question_asked'].includes(e.type))).toBe(false)
    expect(await counts(runId)).toEqual({ register: 0, resolved: 0, questions: 0 })
  })

  test('cancelled while a question is open: the stage stops and nothing is resolved', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding()] })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    await cancelRun(runId)
    step.onWait = async () => ({ data: {} })
    const [row] = await findingsOf(runId)
    step.ids.length = 0
    await drive(runId, s.provider, dir, base, step, s.deps)
    // The stage stopped at the first wake-up: one wait, one read, no second round of waiting.
    expect(step.ids.filter(id => id.startsWith('question-'))).toEqual([`question-${row!.id}-0`])
    expect(step.ids.filter(id => id.startsWith('read-answer-'))).toEqual([`read-answer-${row!.id}-0`])
    expect(step.ids.some(id => id.startsWith('resolve-') || id.startsWith('review-close-'))).toBe(false)
    expect(await counts(runId)).toEqual({ register: 0, resolved: 0, questions: 1 })
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
    expect((await findingsOf(runId))[0]!.entryNumber).toBeNull()
    expect((await node(runId, 'approve')).state).not.toBe('passed')
  })

  test('a fixer that errors leaves the finding open with the reason', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fixerFails: true })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.fixFailed })
    const line = (await listRegister(await projectOf(runId))).find(e => e.kind === 'finding')!
    expect(line.outcome).toBe('open')
  })
})

// ---- each fix is made on its own: saved before, checked after, taken back when it does not work ------------------

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
const text = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8')
/** Reads a snapshot, which lives in the app's store and not in the repository. */
const inStore = (store: string, dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(store, 'objects') } })
const porcelain = (dir: string) => git(dir, 'status', '--porcelain')
const original = 'one\ntwo\nthree!\nfour\nfive\n' // a.tsx as workdir(true) leaves it
const edit = (dir: string, mark: string) => appendFileSync(join(dir, 'a.tsx'), `${mark}\n`)
const stray = (dir: string) => {
  mkdirSync(join(dir, 'src/billing'), { recursive: true })
  appendFileSync(join(dir, 'src/billing/charge.ts'), 'charge changed\n')
}
const money = async (runId: string) => addEntry(await projectOf(runId), { kind: 'core', text: 'Money code', paths: ['src/billing/'], source: 'test' })
const answering = (runId: string, option: string, words?: string) =>
  recordingStep(async () => {
    const q = await openQuestion(runId)
    if (!q) throw new Parked() // the human gate's wait, later on
    await answerQuestion(q.id, { option, ...(words ? { text: words } : {}) }, { send })
    return { data: {} }
  })
const stillShowsProblem = () => seenRun()

describe('one fix at a time, behind a snapshot', () => {
  test('a fix that leaves the problem standing twice is taken back, the finding is open, and Approve counts it under "needs you"', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const before = porcelain(dir)
    const s = scripted({ found: [finding()], fix: (d, n) => { edit(d, `fix ${n}`); writeFileSync(join(d, `added${n}.txt`), 'x') }, after: stillShowsProblem })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(MAX_FIX_ATTEMPTS)
    expect(text(dir, 'a.tsx')).toBe(original)
    expect(existsSync(join(dir, 'added1.txt')) || existsSync(join(dir, 'added2.txt'))).toBe(false)
    expect(porcelain(dir)).toBe(before)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.fixNotSolved, evidence: { exitCode: 1, markerSeen: true } })
    expect((await listRegister(await projectOf(runId))).find(e => e.kind === 'finding')).toMatchObject({ outcome: 'open' })
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 0, needsYou: 1 }))
  })

  test('the edits of a failed first attempt are gone before the second begins, and the second is the one that stays', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const seen: string[] = []
    const s = scripted({ found: [finding()], fix: (d, n) => { seen.push(text(d, 'a.tsx')); edit(d, `fix ${n}`) }, after: n => (n === 1 ? seenRun() : seenRun({ exitCode: 0, markerSeen: false, outputTail: '' })) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(seen).toEqual([original, original])
    expect(text(dir, 'a.tsx')).toBe(`${original}fix 2\n`)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected', evidence: { exitCode: 0 } })
    expect((await listRegister(await projectOf(runId))).find(e => e.kind === 'finding')!.outcome).toBe('done')
  })

  test('a fixer that errors leaves nothing of its edits behind', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const before = porcelain(dir)
    const s = scripted({ found: [finding()], fixerFails: true, fix: d => edit(d, 'half done') })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(text(dir, 'a.tsx')).toBe(original)
    expect(porcelain(dir)).toBe(before)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.fixFailed })
  })

  test('a folder whose state cannot be saved is not touched: nothing is fixed and the finding stays open', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false) // not a repository
    const s = scripted({ found: [finding()] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(s.calls.some(c => c.role === 'fixer')).toBe(false)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.fixNotStarted })
  })

  test('a fix nobody could check stays, unchecked, and counts only under "needs you"', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding({ severity: 'high' })], verify: () => [{ type: 'done', summary: 'v', source: 'provider', repro: null }], fix: d => edit(d, 'fixed') })
    await drive(runId, s.provider, dir, base, answering(runId, 'fix'), s.deps)
    expect(s.reproRuns).toEqual([]) // nothing to run
    expect(text(dir, 'a.tsx')).toBe(`${original}fixed\n`)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'fixed_unchecked' })
    expect((await listRegister(await projectOf(runId))).find(e => e.kind === 'finding')!.outcome).toBe('asked_yes')
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 0, needsYou: 1 }))
  })

  test('fixes run in severity order, one provider call at a time', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    let running = 0
    let overlapped = false
    const s = scripted({
      found: [finding({ problem: 'low one', severity: 'low', type: 'effect' }), finding({ problem: 'high one', severity: 'high', type: 'logic' }), finding({ problem: 'medium one', severity: 'medium', type: 'security' })],
      fix: async () => {
        if (++running > 1) overlapped = true
        await new Promise(r => setTimeout(r, 20))
        running--
      },
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(s.calls.filter(c => c.role === 'fixer').map(c => c.problem)).toEqual(['high one', 'medium one', 'low one'])
    expect(overlapped).toBe(false)
  })

  test('a fix that was recorded in the tree but whose step did not finish is not built on: the tree is the snapshot plus one fix', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => edit(d, 'FIX') })
    const inner = recordingStep()
    class Crash extends Error {}
    let crashed = false
    // The fixer ran and wrote, then the process died before the step's result was stored.
    const step: StepApi = {
      ...inner,
      run: async <T,>(id: string, fn: () => Promise<T> | T): Promise<T> => {
        if (!crashed && id.endsWith('-1') && id.startsWith('fix-')) {
          crashed = true
          await fn()
          throw new Crash()
        }
        return inner.run(id, fn)
      },
    }
    await expect(drive(runId, s.provider, dir, base, step, s.deps)).rejects.toThrow(Crash)
    expect(text(dir, 'a.tsx')).toBe(`${original}FIX\n`)
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(2)
    expect(text(dir, 'a.tsx')).toBe(`${original}FIX\n`) // not FIX twice
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
  })

  test('cancelled while the fixer works: it stops, nothing is checked or recorded, and the tree is left as it is', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: async d => { edit(d, 'in progress'); await cancelRun(runId) } })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(text(dir, 'a.tsx')).toBe(`${original}in progress\n`)
    expect(s.reproRuns).toHaveLength(1) // only the verification
    expect(await counts(runId)).toEqual({ register: 0, resolved: 0, questions: 0 })
  })
})

describe('a small fix that strays into something that matters is held', () => {
  const stage = () => stageResults.at(-1)!

  test('it parks on a question in plain words; "Undo it" brings back the file and removes the one the fix added', async () => {
    const runId = await newRun()
    const entry = (await money(runId))!
    const { dir, base } = workdir(true)
    mkdirSync(join(dir, 'src/billing'), { recursive: true })
    writeFileSync(join(dir, 'src/billing/charge.ts'), 'charge original\n')
    git(dir, 'add', '-A')
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'billing')
    const baseWithBilling = git(dir, 'rev-parse', 'HEAD').trim()
    const before = porcelain(dir)
    const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); stray(d); writeFileSync(join(d, 'src/billing/new-file.ts'), 'added by the fix\n') } })
    const step = recordingStep()
    await drive(runId, s.provider, dir, baseWithBilling, step, s.deps)
    expect(new Set(step.ids).size).toBe(step.ids.length)
    step.ids.length = 0
    const q = (await openQuestion(runId))!
    expect(q).toMatchObject({ kind: 'fix_held', recommended: 'undo', touches: [entry.number] })
    expect(q.options.map(o => o.id)).toEqual(['keep', 'undo', LEAVE])
    expect(q.text).toContain('important')
    for (const hidden of ['src/billing', 'charge.ts', '/']) expect(`${q.text} ${q.why}`).not.toContain(hidden)
    expect(q.detail).toContain('src/billing/charge.ts')
    expect(q.detail).toContain('wrong colour')
    expect(s.reproRuns).toHaveLength(1) // not checked while it waits
    expect((await findingsOf(runId))[0]!.state).toBe('asked')

    await answerQuestion(q.id, { option: 'undo', text: 'too close to payments' }, { send })
    step.onWait = async () => ({ data: {} })
    await drive(runId, s.provider, dir, baseWithBilling, step, s.deps)
    expect(text(dir, 'src/billing/charge.ts')).toBe('charge original\n')
    expect(existsSync(join(dir, 'src/billing/new-file.ts'))).toBe(false)
    expect(text(dir, 'a.tsx')).toBe(original)
    expect(porcelain(dir)).toBe(before)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'discarded', reason: 'too close to payments' })
    expect((await listRegister(await projectOf(runId))).find(e => e.kind === 'finding')).toMatchObject({ outcome: 'asked_no', reason: 'too close to payments' })
    expect(s.reproRuns).toHaveLength(1)
    expect(stage()).toMatchObject({ fixed: false, fixesSince: null })
    expect(new Set(step.ids).size).toBe(step.ids.length)
    void base
  })

  for (const [option, words] of [[LEAVE, undefined], [OTHER, 'let me think about it']] as const) {
    test(`answering "${option}" takes the fix back too, and the problem stays flagged for the person, with their words as the reason`, async () => {
      const runId = await newRun()
      await money(runId)
      const { dir, base } = workdir(true)
      const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); stray(d) } })
      const step = recordingStep()
      await drive(runId, s.provider, dir, base, step, s.deps)
      await answerQuestion((await openQuestion(runId))!.id, { option, ...(words ? { text: words } : {}) }, { send })
      step.onWait = async () => ({ data: {} })
      await drive(runId, s.provider, dir, base, step, s.deps)
      expect(text(dir, 'a.tsx')).toBe(original)
      expect(existsSync(join(dir, 'src/billing/charge.ts'))).toBe(false)
      expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: words ?? strings.findings.fixUndoneOpen })
      expect((await listRegister(await projectOf(runId))).find(e => e.kind === 'finding')!.outcome).toBe('open')
    })
  }

  test('"Keep the fix" goes on to the check; it is recorded as asked_yes and fixesSince is the tree before the fix', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); stray(d) } })
    const first = stageResults.length
    await drive(runId, s.provider, dir, base, answering(runId, 'keep'), s.deps)
    const fixedStage = stageResults.slice(first).find(r => r.fixed)!
    expect(text(dir, 'a.tsx')).toBe(`${original}fix\n`)
    expect(existsSync(join(dir, 'src/billing/charge.ts'))).toBe(true)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
    expect((await listRegister(await projectOf(runId))).find(e => e.kind === 'finding')!.outcome).toBe('asked_yes')
    expect(fixedStage).toMatchObject({ fixed: true })
    expect(inStore(s.deps.snapshotStore!, dir, 'cat-file', '-p', `${fixedStage.fixesSince}:a.tsx`)).toBe(original)
    expect(inStore(s.deps.snapshotStore!, dir, 'ls-tree', '-r', '--name-only', fixedStage.fixesSince!)).not.toContain('charge.ts')
  })

  test('a core path the task had already changed before the fix is not asked about again', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    mkdirSync(join(dir, 'src/billing'), { recursive: true })
    writeFileSync(join(dir, 'src/billing/charge.ts'), 'the task wrote this\n') // differs from the base commit already
    const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); stray(d) } })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(await questionRows(runId)).toHaveLength(0)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
  })

  test('a sensitive kind of file is held too, and named in plain words', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => { mkdirSync(join(d, 'src/auth'), { recursive: true }); writeFileSync(join(d, 'src/auth/login.ts'), 'x\n') } })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const q = (await openQuestion(runId))!
    expect(q.kind).toBe('fix_held')
    expect(q.text).toContain('sign-in and sessions')
    expect(q.touches).toEqual([])
  })

  test('a fix that strays again on the retry, after "Keep", does not ask a second time', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: (d, n) => { edit(d, `fix ${n}`); stray(d) }, after: n => (n === 1 ? seenRun() : seenRun({ exitCode: 0, markerSeen: false, outputTail: '' })) })
    const step = answering(runId, 'keep')
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(2)
    expect((await questionRows(runId)).filter(q => q.kind === 'fix_held')).toHaveLength(1)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
    expect(new Set(step.ids).size).toBe(step.ids.length) // a held fix and a retry share one run without repeating a step id
  })

  test('a finding the person already chose to fix is not held for a stray', async () => {
    const runId = await newRun()
    await addEntry(await projectOf(runId), { kind: 'core', text: 'Money code', paths: ['a.tsx', 'src/billing/'], source: 'test' })
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => stray(d) })
    await drive(runId, s.provider, dir, base, answering(runId, 'fix'), s.deps)
    expect((await questionRows(runId)).map(q => q.kind)).toEqual(['finding'])
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
  })

  for (const prefix of ['ask-held-', 'undo-'] as const) {
    test(`${prefix}<finding> forgotten and run again writes nothing twice`, async () => {
      const runId = await newRun()
      await money(runId)
      const { dir, base } = workdir(true)
      const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); stray(d) } })
      const step = recordingStep()
      await drive(runId, s.provider, dir, base, step, s.deps)
      await answerQuestion((await openQuestion(runId))!.id, { option: 'undo' }, { send })
      step.onWait = async () => ({ data: {} })
      await drive(runId, s.provider, dir, base, step, s.deps)
      const [row] = await findingsOf(runId)
      const before = { ...(await counts(runId)), tree: porcelain(dir), fixers: s.calls.filter(c => c.role === 'fixer').length }
      step.forget(`${prefix}${row!.id}`)
      await drive(runId, s.provider, dir, base, step, s.deps)
      expect({ ...(await counts(runId)), tree: porcelain(dir), fixers: s.calls.filter(c => c.role === 'fixer').length }).toEqual(before)
      expect((await findingsOf(runId))[0]).toMatchObject({ state: 'discarded', entryNumber: row!.entryNumber })
    })
  }
})

describe('taking a fix back only touches what the fix changed', () => {
  const resolveTo = async (runId: string, option: string, step: ReturnType<typeof recordingStep>, s: ReturnType<typeof scripted>, dir: string, base: string, words?: string) => {
    await answerQuestion((await openQuestion(runId))!.id, { option, ...(words ? { text: words } : {}) }, { send })
    step.onWait = async () => ({ data: {} })
    await drive(runId, s.provider, dir, base, step, s.deps)
  }

  test('what the person edits or creates while the run waits survives "Undo it"', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    writeFileSync(join(dir, 'b.txt'), 'b original\n')
    const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); stray(d) } })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect((await openQuestion(runId))!.kind).toBe('fix_held')
    writeFileSync(join(dir, 'b.txt'), 'b edited by the person\n') // the person went to look
    writeFileSync(join(dir, 'person-notes.md'), 'my notes\n')
    await resolveTo(runId, 'undo', step, s, dir, base)
    expect(text(dir, 'b.txt')).toBe('b edited by the person\n')
    expect(text(dir, 'person-notes.md')).toBe('my notes\n')
    expect(text(dir, 'a.tsx')).toBe(original)
    expect(existsSync(join(dir, 'src/billing/charge.ts'))).toBe(false)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'discarded' })
  })

  test('a file the person changed after the fix is left as it is, and the reason says so', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); stray(d) } })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    appendFileSync(join(dir, 'a.tsx'), 'person line\n')
    await resolveTo(runId, 'undo', step, s, dir, base)
    expect(text(dir, 'a.tsx')).toBe(`${original}fix\nperson line\n`)
    expect(existsSync(join(dir, 'src/billing/charge.ts'))).toBe(false)
    expect((await findingsOf(runId))[0]!.reason).toContain(strings.findings.leftAsTheyAre(['a.tsx']))
  })

  test('a fixer that edits an ignored private settings file is held, and "Undo it" puts the file back', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    writeFileSync(join(dir, '.gitignore'), '.env\n')
    writeFileSync(join(dir, '.env'), 'KEY=1\n')
    const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); writeFileSync(join(d, '.env'), 'KEY=changed\n') } })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    const q = (await openQuestion(runId))!
    expect(q.kind).toBe('fix_held')
    expect(q.text).toContain('secrets and environment')
    expect(q.detail).toContain('.env')
    await resolveTo(runId, 'undo', step, s, dir, base)
    expect(text(dir, '.env')).toBe('KEY=1\n')
    expect(text(dir, 'a.tsx')).toBe(original)
  })

  test('after "Keep", a second attempt that strays into other important parts is taken back and the finding stays open', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    const s = scripted({
      found: [finding()],
      fix: (d, n) => {
        edit(d, `fix ${n}`)
        stray(d)
        if (n === 2) { mkdirSync(join(d, 'src/auth'), { recursive: true }); writeFileSync(join(d, 'src/auth/login.ts'), 'x\n') }
      },
      after: () => seenRun(),
    })
    await drive(runId, s.provider, dir, base, answering(runId, 'keep'), s.deps)
    expect((await questionRows(runId)).filter(q => q.kind === 'fix_held')).toHaveLength(1)
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(2)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.strayedAgain })
    expect(existsSync(join(dir, 'src/auth/login.ts'))).toBe(false)
    expect(text(dir, 'a.tsx')).toBe(original)
    expect(existsSync(join(dir, 'src/billing/charge.ts'))).toBe(false)
  })

  test('a git error after the fixer ran does not leave the run stuck: the finding ends open, saying the fix could not be taken back', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({
      found: [finding()],
      fix: d => {
        edit(d, 'fix')
        mkdirSync(join(d, 'sub'))
        execFileSync('git', ['init', '-q'], { cwd: join(d, 'sub') })
        writeFileSync(join(d, 'sub/x.txt'), 'x')
      },
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    // The files are named, found path by path (no snapshot can be taken here).
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.fixNotTakenBack(['a.tsx', 'sub']) })
    expect((await node(runId, 'review')).state).toBe('passed')
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(1)
  })

  test('the first fix undone and the second kept: fixesSince is the second one\'s snapshot', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    const s = scripted({
      found: [finding({ problem: 'first', type: 'logic', severity: 'high' }), finding({ problem: 'second', type: 'effect', severity: 'medium' })],
      fix: (d, n) => (n === 1 ? (edit(d, 'fix 1'), stray(d)) : edit(d, 'fix 2')),
    })
    const step = recordingStep()
    const first = stageResults.length
    await drive(runId, s.provider, dir, base, step, s.deps)
    writeFileSync(join(dir, 'person.txt'), 'made while waiting\n')
    await resolveTo(runId, 'undo', step, s, dir, base)
    const rows = await findingsOf(runId)
    expect(rows.map(r => r.state).sort()).toEqual(['corrected', 'discarded'])
    const fixedStage = stageResults.slice(first).find(r => r.fixed)!
    expect(fixedStage).toMatchObject({ fixed: true })
    const since = fixedStage.fixesSince!
    expect(inStore(s.deps.snapshotStore!, dir, 'ls-tree', '-r', '--name-only', since)).toContain('person.txt') // taken after the first fix was undone
    expect(text(dir, 'a.tsx')).toBe(`${original}fix 2\n`)
  })

  test('a later finding\'s rollback keeps an earlier finding\'s fix', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({
      found: [finding({ problem: 'first', type: 'logic', severity: 'high' }), finding({ problem: 'second', type: 'effect', severity: 'medium' })],
      fix: (d, n) => { edit(d, `fix ${n}`); writeFileSync(join(d, `added${n}.txt`), 'x') },
      after: n => (n === 1 ? seenRun({ exitCode: 0, markerSeen: false, outputTail: '' }) : seenRun()),
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId)).map(r => r.state).sort()).toEqual(['corrected', 'open'])
    expect(text(dir, 'a.tsx')).toBe(`${original}fix 1\n`)
    expect(existsSync(join(dir, 'added1.txt'))).toBe(true)
    expect(existsSync(join(dir, 'added2.txt')) || existsSync(join(dir, 'added3.txt'))).toBe(false)
  })

  test('rollback- forgotten and run again writes nothing twice and changes nothing', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: (d, n) => edit(d, `fix ${n}`), after: () => seenRun() })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    const [row] = await findingsOf(runId)
    writeFileSync(join(dir, 'person.txt'), 'later\n')
    const before = { ...(await counts(runId)), a: text(dir, 'a.tsx'), fixers: s.calls.filter(c => c.role === 'fixer').length }
    step.forget(`rollback-${row!.id}`)
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect({ ...(await counts(runId)), a: text(dir, 'a.tsx'), fixers: s.calls.filter(c => c.role === 'fixer').length }).toEqual(before)
    expect(text(dir, 'person.txt')).toBe('later\n')
    expect(before.a).toBe(original)
  })
})

describe('round 2', () => {
  test('a crash while the second attempt\'s fixer ran takes back only that attempt, not what the person did while the run waited', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    writeFileSync(join(dir, 'b.txt'), 'b original\n')
    const s = scripted({
      found: [finding()],
      fix: (d, n) => { edit(d, `fix ${n}`); stray(d) },
      after: n => (n === 1 ? seenRun() : seenRun({ exitCode: 0, markerSeen: false, outputTail: '' })),
    })
    const inner = recordingStep()
    class Crash extends Error {}
    let crashed = false
    const step: StepApi = {
      ...inner,
      run: async <T,>(id: string, fn: () => Promise<T> | T): Promise<T> => {
        if (!crashed && id.startsWith('fix-') && id.endsWith('-2')) {
          crashed = true
          await fn() // the fixer ran and wrote; the process died before the result was stored
          throw new Crash()
        }
        return inner.run(id, fn)
      },
    }
    await drive(runId, s.provider, dir, base, step, s.deps) // parks on the held question
    writeFileSync(join(dir, 'b.txt'), 'b edited by the person\n')
    writeFileSync(join(dir, 'notes.md'), 'notes\n')
    await answerQuestion((await openQuestion(runId))!.id, { option: 'keep' }, { send })
    inner.onWait = async () => ({ data: {} })
    await expect(drive(runId, s.provider, dir, base, step, s.deps)).rejects.toThrow(Crash)
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(text(dir, 'b.txt')).toBe('b edited by the person\n')
    expect(text(dir, 'notes.md')).toBe('notes\n')
    expect(text(dir, 'a.tsx')).toBe(`${original}fix 3\n`) // the third fixer call; the second's half-edit is not under it
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(3)
  })

  test('a fixer that runs a build or the tests does not make the app ask about generated files', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    writeFileSync(join(dir, '.gitignore'), '.next/\ncoverage/\ndist/\n')
    const s = scripted({
      found: [finding()],
      fix: d => {
        edit(d, 'fix')
        for (const f of ['.next/server/app/api/auth/route.js', 'coverage/src/auth/login.ts.html', 'dist/auth/login.js']) {
          mkdirSync(join(d, f, '..'), { recursive: true })
          writeFileSync(join(d, f), 'generated')
        }
      },
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(await questionRows(runId)).toHaveLength(0)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
  })

  test('the stray paths a step carries are cut to 200 with the rest counted, and the question still names them', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => { edit(d, 'fix'); mkdirSync(join(d, 'src/billing'), { recursive: true }); for (let i = 0; i < 250; i++) writeFileSync(join(d, `src/billing/f${i}.ts`), 'x') } })
    const inner = recordingStep()
    const kept: Record<string, unknown> = {}
    const step: StepApi = { ...inner, run: async <T,>(id: string, fn: () => Promise<T> | T): Promise<T> => { const r = await inner.run(id, fn); kept[id] = r; return r } }
    await drive(runId, s.provider, dir, base, step, s.deps)
    const made = Object.entries(kept).find(([id]) => /^fix-.*-1$/.test(id))![1] as { strays: { paths: string[]; more: number }; paths: string[]; count: number }
    expect(made.count).toBe(251)
    expect(made.paths).toHaveLength(200)
    expect(made.strays.paths).toHaveLength(200)
    expect(made.strays.more).toBe(50)
    expect((await openQuestion(runId))!.kind).toBe('fix_held')
  })

  test('an attempt\'s marker is gone when the finding has an ending', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => edit(d, 'fix') })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const [row] = await findingsOf(runId)
    const left = existsSync(join(s.deps.snapshotStore!, 'attempts')) ? readdirSync(join(s.deps.snapshotStore!, 'attempts')) : []
    expect(row!.state).toBe('corrected')
    expect(left.filter(n => n.startsWith(row!.id))).toEqual([])
  })

  test('a fix that cannot be taken back is told as a short list of files, however many there are', async () => {
    expect(strings.findings.leftAsTheyAre(Array.from({ length: 30 }, (_, i) => `f${i}`))).toContain('and 10 more')
  })
})

describe('round 3: every try is measured against its own start', () => {
  /** Keep on the held question of attempt 1; the person works during the park. Attempt 1 never solves it. */
  async function parked(over: Partial<Script>, personWorks: (dir: string) => void) {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    writeFileSync(join(dir, 'b.txt'), 'b original\n')
    const s = scripted({
      found: [finding()],
      fix: (d, n) => {
        if (n === 1) { edit(d, 'fix 1'); stray(d); writeFileSync(join(d, 'f1new.txt'), 'added by fix 1\n') }
      },
      after: n => (n === 1 ? seenRun() : seenRun({ exitCode: 0, markerSeen: false, outputTail: '' })),
      ...over,
    })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect((await openQuestion(runId))!.kind).toBe('fix_held')
    personWorks(dir)
    await answerQuestion((await openQuestion(runId))!.id, { option: 'keep' }, { send })
    step.onWait = async () => ({ data: {} })
    await drive(runId, s.provider, dir, base, step, s.deps)
    return { runId, dir, s }
  }
  const personWorks = (dir: string) => {
    writeFileSync(join(dir, 'b.txt'), 'b edited by the person\n')
    writeFileSync(join(dir, 'notes.md'), 'notes\n')
    appendFileSync(join(dir, 'f1new.txt'), 'person added a line\n')
  }
  const survives = (dir: string) => {
    expect(text(dir, 'b.txt')).toBe('b edited by the person\n')
    expect(text(dir, 'notes.md')).toBe('notes\n')
    expect(text(dir, 'f1new.txt')).toBe('added by fix 1\nperson added a line\n')
    expect(text(dir, 'a.tsx')).toBe(original)
  }

  test('attempt 2 fails its check: its own edits are taken back, and what the person did during the park stays', async () => {
    const { runId, dir, s } = await parked({ fix: (d, n) => { if (n === 1) { edit(d, 'fix 1'); stray(d); writeFileSync(join(d, 'f1new.txt'), 'added by fix 1\n') } else { edit(d, 'fix 2'); writeFileSync(join(d, 'added2.txt'), 'x') } }, after: () => seenRun() }, personWorks)
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(2)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open' })
    survives(dir)
    expect(existsSync(join(dir, 'added2.txt'))).toBe(false)
  })

  test('attempt 2 strays into other important parts: taken back the same way, the person\'s files stay', async () => {
    const { runId, dir } = await parked({ fix: (d, n) => { if (n === 1) { edit(d, 'fix 1'); stray(d); writeFileSync(join(d, 'f1new.txt'), 'added by fix 1\n') } else { edit(d, 'fix 2'); mkdirSync(join(d, 'src/auth'), { recursive: true }); writeFileSync(join(d, 'src/auth/login.ts'), 'x') } }, after: () => seenRun() }, personWorks)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.strayedAgain })
    survives(dir)
    expect(existsSync(join(dir, 'src/auth/login.ts'))).toBe(false)
  })

  test('what the person did to an important file during the park is not counted as the second try straying', async () => {
    const { runId, dir } = await parked({ fix: (d, n) => { if (n === 1) { edit(d, 'fix 1'); stray(d) } else edit(d, 'fix 2') } }, d => {
      writeFileSync(join(d, 'src/billing/person.ts'), 'mine\n')
    })
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'corrected' })
    expect(text(dir, 'src/billing/person.ts')).toBe('mine\n')
  })

  test('an empty marker on a crash re-run is a failed attempt: the finding is open and the folder is left alone', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: d => edit(d, 'FIX') })
    const inner = recordingStep()
    class Crash extends Error {}
    let crashed = false
    const step: StepApi = {
      ...inner,
      run: async <T,>(id: string, fn: () => Promise<T> | T): Promise<T> => {
        if (!crashed && id.startsWith('fix-') && id.endsWith('-1')) {
          crashed = true
          await fn()
          throw new Crash()
        }
        return inner.run(id, fn)
      },
    }
    await expect(drive(runId, s.provider, dir, base, step, s.deps)).rejects.toThrow(Crash)
    const attempts = join(s.deps.snapshotStore!, 'attempts')
    for (const name of readdirSync(attempts)) writeFileSync(join(attempts, name), '')
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(1)
    expect(text(dir, 'a.tsx')).toBe(`${original}FIX\n`)
    expect((await findingsOf(runId))[0]).toMatchObject({ state: 'open', reason: strings.findings.fixFailed })
  })
})

describe('after fixes, the checks run again and the change is read once more', () => {
  const kinds = (s: { calls: { role?: string; kind: string }[] }) =>
    s.calls.filter(c => !c.role && ['build', 'tests', 'review'].includes(c.kind)).map(c => c.kind).filter((k, i, all) => all[i - 1] !== k)
  const readers = (s: { calls: { role?: string; kind: string; focus?: Focus }[] }) => s.calls.filter(c => !c.role && c.kind === 'review').map(c => c.focus)
  const reopens = async (runId: string) =>
    (await eventsSince(runId, 0)).filter(e => e.type === 'node.reopened').map(e => e.payload as { blockId: string; round: number; by: string; note: string })
  const second = finding({ type: 'effect', line: 5, problem: 'a different problem' })
  const refuted: AgentEvent[] = [{ type: 'done', summary: 'r', source: 'provider', repro: null, refuted: { why: 'it does not' } }]
  const states = async (runId: string) => (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).map(n => `${n.blockId}:${n.state}`).sort()

  test('one fix, then a clean second look: Tests and Review run again, Build does not, and the second reader gets what the fix changed', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: (d, n) => edit(d, `fix ${n}`) })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(kinds(s)).toEqual(['build', 'tests', 'review', 'tests', 'review'])
    expect(await reopens(runId)).toEqual([
      { blockId: 'tests', round: 2, by: 'fixes', note: strings.run.reopenedAfterFixes },
      { blockId: 'review', round: 2, by: 'fixes', note: strings.run.reopenedAfterFixes },
    ])
    const reviews = s.calls.filter(c => !c.role && c.kind === 'review')
    expect(reviews[0]!.since).toBeUndefined()
    expect(reviews.at(-1)!.since?.paths).toEqual(['a.tsx'])
    expect(reviews.at(-1)!.since?.diff).toContain('+fix 1')
    expect(step.ids).toEqual(expect.arrayContaining(['review-since-review-r2', 'review-depth-review-r2', 'reopen-fixes-review', 'review-open-review-r2']))
    expect(new Set(step.ids).size).toBe(step.ids.length)
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected'])
  })

  test('how many read the second time is measured on what the fixes changed: a big fix gets three even when the task was small', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: (d, n) => { edit(d, `fix ${n}`); for (let i = 0; i < 9; i++) writeFileSync(join(d, `gen${i}.txt`), 'x\n') } })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(readers(s)).toEqual(['logic', 'logic', 'security', 'effects'])
  })

  test('and a small fix gets one reader even when the whole task was big', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    for (let i = 0; i < 9; i++) writeFileSync(join(dir, `task${i}.txt`), 'x\n')
    const s = scripted({ found: [finding()], fix: (d, n) => edit(d, `fix ${n}`) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(readers(s)).toEqual(['logic', 'security', 'effects', 'logic'])
  })

  test('fixes in both reviews: after the last review nothing is read again, but Tests run once more and then the run goes to the human check', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [second] : []), fix: (d, n) => edit(d, `fix ${n}`) })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(kinds(s)).toEqual(['build', 'tests', 'review', 'tests', 'review', 'tests'])
    expect(readers(s)).toEqual(['logic', 'logic'])
    expect(await reopens(runId)).toEqual([
      { blockId: 'tests', round: 2, by: 'fixes', note: strings.run.reopenedAfterFixes },
      { blockId: 'review', round: 2, by: 'fixes', note: strings.run.reopenedAfterFixes },
      { blockId: 'tests', round: 3, by: 'fixes', note: strings.run.reopenedChecksAfterFixes },
    ])
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'corrected'])
    expect((await node(runId, 'review')).state).toBe('passed')
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
    expect(new Set(step.ids).size).toBe(step.ids.length)
  })

  test('without a Tests block only Review is reopened, and after the last review nothing is', async () => {
    const runId = await newRun(g => { g.blocks.find(b => b.kind === 'tests')!.enabled = false })
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [second] : pass === 3 ? [finding({ line: 1, problem: 'never read' })] : []), fix: (d, n) => edit(d, `fix ${n}`) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(s.calls.some(c => c.kind === 'tests')).toBe(false)
    expect(s.calls.filter(c => !c.role && c.kind === 'review' && c.focus === 'logic')).toHaveLength(2)
    expect((await reopens(runId)).map(r => `${r.blockId}:${r.round}`)).toEqual(['review:2'])
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'corrected'])
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
  })

  test('nothing fixed, nothing reopened: a refuted problem, a fixer that fails and a problem that was left alone', async () => {
    for (const script of [
      { found: [finding()], verify: () => refuted },
      { found: [finding()], fixerFails: true },
    ]) {
      const runId = await newRun()
      const { dir, base } = workdir(true)
      const s = scripted(script)
      await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
      expect(await reopens(runId)).toEqual([])
      expect(kinds(s)).toEqual(['build', 'tests', 'review'])
      expect((await node(runId, 'human')).state).toBe('waiting_approval')
    }
  })

  test('when the tests fail the second time, the run fails as a failing Tests block always does: Build is not run again', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const failing: AgentEvent[] = [
      { type: 'evidence', kind: 'test_run', data: { command: 'npm test', exitCode: 1, signal: null, started: true, durationMs: 5, counts: null, outputTail: 'FAIL', changedTestFiles: [] } },
      { type: 'error', source: 'system', cause: 'tests_failed', message: 'The tests failed.' },
    ]
    const s = scripted({ found: [finding()], fix: (d, n) => edit(d, `fix ${n}`), duringTests: n => (n === 2 ? failing : undefined) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(kinds(s)).toEqual(['build', 'tests', 'review', 'tests'])
    expect(s.calls.filter(c => !c.role && c.kind === 'build')).toHaveLength(1)
    expect((await node(runId, 'tests')).state).toBe('failed')
    expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('failed')
    expect((await node(runId, 'human')).state).not.toBe('waiting_approval')
    expect((await payloads(runId, 'node.step', 'tests')).map(p => p.text)).toContain(strings.run.testsFailedAfterFixes)
  })

  test('tests that fail the first time carry no sentence about fixes', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const failing: AgentEvent[] = [
      { type: 'evidence', kind: 'test_run', data: { command: 'npm test', exitCode: 1, signal: null, started: true, durationMs: 5, counts: null, outputTail: 'FAIL', changedTestFiles: [] } },
      { type: 'error', source: 'system', cause: 'tests_failed', message: 'The tests failed.' },
    ]
    const s = scripted({ found: [], duringTests: () => failing })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await payloads(runId, 'node.step', 'tests')).map(p => p.text)).not.toContain(strings.run.testsFailedAfterFixes)
  })

  test('the person asking for changes starts again at Build with a fresh budget of reviews', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 || pass === 3 ? [second] : []), fix: (d, n) => edit(d, `fix ${n}`) })
    let asked = false
    const step = recordingStep(async () => {
      if (!asked) {
        asked = true
        await recordDecision(runId, 'changes', { actor: 'test', reason: 'make it red', diffHash: null })
        return { data: {} }
      }
      throw new Parked()
    })
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(kinds(s)).toEqual(['build', 'tests', 'review', 'tests', 'review', 'tests', 'build', 'tests', 'review', 'tests', 'review'])
    const all = await reopens(runId)
    expect(all.filter(r => r.by === 'person' && r.blockId === 'build')).toHaveLength(1)
    expect(all.filter(r => r.by === 'fixes').map(r => `${r.blockId}:${r.round}`)).toEqual(['tests:2', 'review:2', 'tests:3', 'tests:5', 'review:5'])
    const reviews = s.calls.filter(c => !c.role && c.kind === 'review')
    expect(reviews.map(r => r.since !== undefined)).toEqual([false, true, false, true])
    // What the person reads: only their own request counts as a round.
    expect(all.filter(r => r.by === 'person').map(r => (r as { asked?: number }).asked)).toEqual([2, 2, 2, 2, 2])
    expect(all.filter(r => r.by === 'fixes').some(r => 'asked' in r)).toBe(false)
    const { describeEvent } = await import('@/ui/EventBar')
    const blockOf = (id: string) => ({ id, kind: id, label: id, enabled: true, config: {}, position: { x: 0, y: 0 } }) as never
    const said = (await eventsSince(runId, 0)).filter(e => e.type === 'node.reopened').map(e => describeEvent(e as never, blockOf((e.payload as { blockId: string }).blockId)).text)
    expect(said.filter(t => /round/i.test(t)).every(t => t === 'Sent back for round 2: make it red')).toBe(true)
    expect(new Set(step.ids).size).toBe(step.ids.length)
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
  })

  test('forgetting the reopen steps and driving again changes nothing and runs nothing', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [second] : []), fix: (d, n) => edit(d, `fix ${n}`) })
    const step = recordingStep()
    await drive(runId, s.provider, dir, base, step, s.deps)
    const before = { events: (await eventsSince(runId, 0)).length, states: await states(runId), calls: s.calls.length, a: text(dir, 'a.tsx') }
    step.forget('reopen-fixes-review')
    step.forget('reopen-fixes-review-r2')
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect({ events: (await eventsSince(runId, 0)).length, states: await states(runId), calls: s.calls.length, a: text(dir, 'a.tsx') }).toEqual(before)
  })

  test('a run cancelled between the two reviews stops: nothing is reopened and nothing runs again', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: (d, n) => edit(d, `fix ${n}`) })
    const inner = recordingStep()
    const step: StepApi = {
      ...inner,
      run: (id, fn) => inner.run(id, id === 'reopen-fixes-review' ? async () => { await cancelRun(runId); return fn() } : fn),
    }
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect(await reopens(runId)).toEqual([])
    expect(kinds(s)).toEqual(['build', 'tests', 'review'])
    expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('cancelled')
  })

  test('a problem fixed in the first review and not reported again stays fixed in the summary', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: (d, n) => edit(d, `fix ${n}`) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 1, discarded: 0, needsYou: 0 }))
  })

  test('a problem fixed in the first review and refuted when reported again still counts as fixed: the fix is what made it untrue', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    let verified = 0
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [finding()] : []), fix: (d, n) => edit(d, `fix ${n}`), verify: () => (++verified === 1 ? reproduces() : refuted) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'refuted'])
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 1, discarded: 0, needsYou: 0 }))
  })

  test('fixed in the first review and reported and fixed again in the second: one problem, fixed', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [finding()] : []), fix: (d, n) => edit(d, `fix ${n}`) })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'corrected'])
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 1, discarded: 0, needsYou: 0 }))
  })

  test('fixed in the first review and reported again with the fix not holding: it needs the person and is not counted as fixed', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({
      found: [finding()],
      later: pass => (pass === 2 ? [finding()] : []),
      fix: (d, n) => edit(d, `fix ${n}`),
      after: n => (n === 1 ? seenRun({ exitCode: 0, markerSeen: false, outputTail: '' }) : seenRun()),
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'open'])
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 0, needsYou: 1 }))
  })

  test('when the app cannot narrow the second look it says so, reads the whole change, and measures the depth on the whole task', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    for (let i = 0; i < 9; i++) writeFileSync(join(dir, `task${i}.txt`), 'x\n')
    const s = scripted({
      found: [finding()],
      fix: (d, n) => edit(d, `fix ${n}`),
      duringTests: n => { if (n === 2) rmSync(join(s.deps.snapshotStore!, 'objects'), { recursive: true, force: true }) },
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect(readers(s)).toEqual(['logic', 'security', 'effects', 'logic', 'security', 'effects'])
    expect(s.calls.filter(c => !c.role && c.kind === 'review').every(c => c.since === undefined)).toBe(true)
    const said = (await payloads(runId, 'node.step', 'review')).map(p => p.text)
    expect(said.filter(t => t === strings.review.sinceUnreadable)).toHaveLength(1)
  })

  test('a long list of changed files is cut to 200 in the step, with the rest counted, and still reads as high risk', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], fix: (d, n) => { edit(d, `fix ${n}`); for (let i = 0; i < 230; i++) writeFileSync(join(d, `gen${i}.txt`), 'x\n') } })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const last = s.calls.filter(c => !c.role && c.kind === 'review').at(-1)!
    expect(last.since!.paths).toHaveLength(200)
    expect(last.since!.more).toBe(31)
    expect(readers(s)).toEqual(['logic', 'logic', 'security', 'effects'])
  })

  test('fixed in the first review, reproduced again in the second, and the person leaves it: discarded, not fixed', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [finding()] : []), fix: (d, n) => edit(d, `fix ${n}`) })
    let n = 0
    const step = recordingStep(async () => {
      const q = await openQuestion(runId)
      if (!q) throw new Parked()
      await answerQuestion(q.id, { option: n++ === 0 ? 'fix' : LEAVE }, { send })
      return { data: {} }
    })
    await drive(runId, s.provider, dir, base, step, s.deps)
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'discarded'])
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 1, needsYou: 0 }))
  })

  test('fixed in the first review, and the second fix strays and is undone: discarded, not fixed', async () => {
    const runId = await newRun()
    await money(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [finding()] : []), fix: (d, n) => { edit(d, `fix ${n}`); if (n === 2) stray(d) } })
    await drive(runId, s.provider, dir, base, answering(runId, 'undo'), s.deps)
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'discarded'])
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 1, needsYou: 0 }))
  })

  test('fixed in the first review and reported again with a fix nobody could check: it needs the person and nothing else', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(true)
    let verified = 0
    const s = scripted({
      found: [finding()],
      later: pass => (pass === 2 ? [finding({ severity: 'high' })] : []),
      fix: (d, n) => edit(d, `fix ${n}`),
      verify: () => (++verified === 1 ? reproduces() : [{ type: 'done', summary: 'v', source: 'provider', repro: null }]),
    })
    await drive(runId, s.provider, dir, base, answering(runId, 'fix'), s.deps)
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['corrected', 'fixed_unchecked'])
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 0, needsYou: 1 }))
  })

  test('set aside in the first review and fixed in the second: fixed', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(true)
    const b = finding({ type: 'effect', line: 5, problem: 'b problem' })
    const seen: Record<string, number> = {}
    const s = scripted({
      found: [finding(), b],
      later: pass => (pass === 2 ? [b] : []),
      fix: (d, n) => edit(d, `fix ${n}`),
      verify: problem => {
        seen[problem] = (seen[problem] ?? 0) + 1
        return problem === 'b problem' && seen[problem] === 1 ? [{ type: 'done', summary: 'v', source: 'provider', repro: null }] : reproduces()
      },
    })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    expect((await findingsOf(runId)).map(r => r.state).sort()).toEqual(['corrected', 'corrected', 'discarded'])
    expect((await payloads(runId, 'node.completed', 'approve')).at(-1)!.summary).toBe(strings.review.approve.summary({ found: 2, fixed: 2, discarded: 0, needsYou: 0 }))
  })

  test('a problem asked about in the first review is asked about again in the second: the answer to the first is not reused', async () => {
    const runId = await newRun()
    await withCore(runId)
    const { dir, base } = workdir(true)
    const s = scripted({ found: [finding()], later: pass => (pass === 2 ? [finding()] : []), fix: (d, n) => edit(d, `fix ${n}`) })
    await drive(runId, s.provider, dir, base, answering(runId, 'fix'), s.deps)
    const asked = await questionRows(runId)
    expect(asked).toHaveLength(2)
    expect(new Set(asked.map(q => q.findingId)).size).toBe(2)
    expect(s.calls.filter(c => c.role === 'fixer')).toHaveLength(2)
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
  })
})

describe('the demo provider', () => {
  test('goes through Review exactly as before', async () => {
    const runId = await newRun()
    await db.update(runs).set({ providerId: 'demo' }).where(eq(runs.id, runId))
    try {
      await orchestrateRun(runId, recordingStep(), { resolveProvider: () => createDemoProvider({ stepDelayMs: 1 }) })
    } catch (e) {
      if (!(e instanceof Parked)) throw e
    }
    // Every event of the run, in order: the Review block's part in it is what must not change.
    expect((await eventsSince(runId, 0)).map(e => e.type)).toMatchInlineSnapshot(`
      [
        "run.created",
        "node.queued",
        "node.queued",
        "node.queued",
        "node.queued",
        "node.queued",
        "node.queued",
        "node.queued",
        "node.queued",
        "run.started",
        "node.started",
        "node.step",
        "node.step",
        "node.completed",
        "node.started",
        "node.step",
        "node.step",
        "node.step",
        "node.step",
        "node.completed",
        "node.started",
        "node.step",
        "node.step",
        "node.step",
        "node.completed",
        "node.started",
        "node.step",
        "node.step",
        "node.completed",
        "node.started",
        "node.step",
        "node.step",
        "node.step",
        "node.completed",
        "node.started",
        "node.step",
        "node.step",
        "node.completed",
        "node.started",
        "run.waiting_approval",
        "node.waiting_approval",
      ]
    `)
  })
})

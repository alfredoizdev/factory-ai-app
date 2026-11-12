import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, questions, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { findingsOf } from '@/engine/findings'
import { MAX_FINDINGS } from '@/engine/review'
import { addEntry, listRegister } from '@/engine/register'
import { answerQuestion, LEAVE, openQuestion, OTHER } from '@/engine/questions'
import type { Repro, ReproRun } from '@/engine/repro'
import { orchestrateRun, type ExecutorDeps, type StepApi } from '@/engine/inngest/execute-run'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import type { Finding, Focus } from '@/engine/review'
import { createDemoProvider } from '@/providers/demo'
import type { AgentEvent, AgentProvider } from '@/providers/types'
import { strings } from '@/ui/strings'

// The Review block reads the change with one reviewer or three, and checks what they found before the builder sees it.

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

class Parked extends Error {}
// Like Inngest: a step that finished is not run again, its stored result is handed back. Every id asked for is kept.
function recordingStep(onWait: () => Promise<{ data: Record<string, never> } | null> = async () => {
  throw new Parked()
}): StepApi & { ids: string[]; onWait: typeof onWait } {
  const ids: string[] = []
  const done = new Map<string, unknown>()
  const self = {
    ids,
    onWait,
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

async function newRun(): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: '/repo' })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'do it' })
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  return runId
}

/** A folder with a.tsx in it. `git` makes it a repository whose one commit is the base, with a small change on top. */
function workdir(git: boolean): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-review-'))
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
    expect((await node(runId, 'review')).summary).toBe(strings.review.noProblemsLeft)
    expect((await findingsOf(runId)).map(r => r.state)).toEqual(['refuted'])
    expect((await eventsSince(runId, 0)).some(e => e.type === 'node.reopened')).toBe(false)
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
    expect(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 1, needsYou: 0 })).toBe('1 problem found. 1 discarded.')
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
  /** Findings the logic reviewer reports. */
  found: Finding[]
  /** What the verifier answers for a finding (by its problem text). Default: it reproduced it. */
  verify?: (problem: string) => AgentEvent[]
  /** What the app's own run of the reproduction shows. Default: the problem happened. */
  repro?: (problem: string) => ReproRun
}
const reproduces = (): AgentEvent[] => [{ type: 'done', summary: 'v', source: 'provider', repro }]

function scripted(script: Script) {
  const calls: { role?: string; workdir?: string; problem?: string; repro?: Repro; kind: string }[] = []
  const copies: string[] = []
  const reproRuns: string[] = []
  const provider: AgentProvider = {
    id: 'files',
    isDemo: false,
    needsWorkspace: true,
    async *execute(input) {
      calls.push({ role: input.role, workdir: input.workdir, problem: input.finding?.problem, repro: input.repro, kind: input.blockKind })
      if (input.role === 'verifier') {
        for (const ev of (script.verify ?? reproduces)(input.finding!.problem)) yield ev
        return
      }
      if (input.role === 'fixer') {
        yield { type: 'done', summary: 'fixed', source: 'provider' }
        return
      }
      if (input.blockKind === 'tests') yield passingTests
      if (input.blockKind === 'review') {
        for (const ev of input.focus === 'logic' ? says(...script.found) : says()) yield ev
        return
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  const deps: Partial<ExecutorDeps> = {
    makeCopy: async () => {
      const c = mkdtempSync(join(tmpdir(), 'factory-copy-'))
      copies.push(c)
      return c
    },
    runRepro: async (r, wd) => {
      reproRuns.push(wd)
      expect(r).toEqual(repro)
      return (script.repro ?? (() => seenRun()))(calls.filter(c => c.role === 'verifier').at(-1)!.problem!)
    },
  }
  return { provider, deps, calls, copies, reproRuns }
}
const send = async () => {}
const questionRows = (runId: string) => db.select().from(questions).where(eq(questions.runId, runId))

describe('a finding is verified, then fixed or asked about', () => {
  test('a reproduced small problem goes to the fixer; nothing is asked and the verifier never works in the task', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const s = scripted({ found: [finding()] })
    await drive(runId, s.provider, dir, base, recordingStep(), s.deps)
    const verifier = s.calls.filter(c => c.role === 'verifier')
    const fixer = s.calls.filter(c => c.role === 'fixer')
    expect(verifier).toHaveLength(1)
    expect(verifier[0]!.workdir).toBe(s.copies[0])
    expect(verifier[0]!.workdir).not.toBe(dir)
    expect(s.reproRuns).toEqual([dir]) // the app runs the repro itself, from the task's folder (which it copies)
    expect(s.copies.every(c => !existsSync(c))).toBe(true)
    expect(fixer).toHaveLength(1)
    expect(fixer[0]).toMatchObject({ workdir: dir, problem: 'wrong colour', repro })
    expect(await questionRows(runId)).toHaveLength(0)
    const [row] = await findingsOf(runId)
    expect(row).toMatchObject({ state: 'fixed_unchecked', evidence: { exitCode: 1, markerSeen: true } })
    expect(row!.entryNumber).not.toBeNull()
    expect((await node(runId, 'review')).state).toBe('passed')
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    const line = (await listRegister(projectId)).find(e => e.kind === 'finding')!
    expect(line).toMatchObject({ number: row!.entryNumber, outcome: 'unchecked', runId, paths: ['a.tsx'] })
    expect(await payloads(runId, 'node.finding_resolved', 'review')).toEqual([{ blockId: 'review', findingId: row!.id, state: 'fixed_unchecked', outcome: 'unchecked' }])
    expect((await eventsSince(runId, 0)).some(e => e.type === 'node.reopened')).toBe(false)
    const approve = await payloads(runId, 'node.completed', 'approve')
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
      const { dir, base } = workdir(false)
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
        expect(row!.state).toBe('fixed_unchecked')
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
    expect(rows.every(r => r.entryNumber !== null && r.state === 'discarded')).toBe(true)
    const approve = await payloads(runId, 'node.completed', 'approve')
    expect(approve.at(-1)!.summary).toBe(strings.review.approve.summary({ found: MAX_FINDINGS + 2, fixed: 0, discarded: MAX_FINDINGS, needsYou: 2 }))
  })

  test('several findings and a question: no step id is used twice, and a retried step writes nothing twice', async () => {
    const runId = await newRun()
    const projectId = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.projectId
    await addEntry(projectId, { kind: 'core', text: 'Money code', paths: ['b.tsx'], source: 'test' })
    const { dir, base } = workdir(false)
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

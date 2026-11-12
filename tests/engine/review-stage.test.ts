import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { findingsOf } from '@/engine/findings'
import { orchestrateRun, type StepApi } from '@/engine/inngest/execute-run'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import type { Finding, Focus } from '@/engine/review'
import { createDemoProvider } from '@/providers/demo'
import type { AgentEvent, AgentProvider } from '@/providers/types'
import { strings } from '@/ui/strings'

// The Review block reads the change with one reviewer or three, and checks what they found before the builder sees it.

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

class Parked extends Error {}
function recordingStep(ids: string[] = []): StepApi {
  return {
    run: async (id, fn) => {
      ids.push(id)
      return JSON.parse(JSON.stringify((await fn()) ?? null))
    },
    waitForEvent: async () => {
      throw new Parked()
    },
  }
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

async function drive(runId: string, provider: AgentProvider, dir: string, base: string, ids?: string[]) {
  try {
    await orchestrateRun(runId, recordingStep(ids), { resolveProvider: () => provider, createWorktree: () => ({ path: dir, branch: 'b', baseCommit: base }) })
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
    const ids: string[] = []
    await drive(runId, provider, dir, base, ids)
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
    const ids: string[] = []
    await drive(runId, provider, dir, base, ids)
    expect(asked).toEqual(['logic'])
    expect(ids).not.toContain('review-review-security')
    const steps = (await payloads(runId, 'node.step', 'review')).map(p => p.text)
    expect(steps).toContain(strings.review.depth.one)
  })
})

describe('what the reviewers found', () => {
  test('a line two reviewers reported reaches the builder once', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider, seen } = reviewers((focus, round) => (round === 1 && focus !== 'effects' ? says(finding({ line: focus === 'logic' ? 3 : 4 })) : says()))
    await drive(runId, provider, dir, base)
    const builds = seen.filter(s => s.kind === 'build')
    expect(builds).toHaveLength(2)
    expect(builds[1]!.note!.match(/wrong colour/g)).toHaveLength(1)
    expect(builds[1]!.note).toContain('a.tsx:3: wrong colour')
    const rows = await findingsOf(runId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reporters: ['logic', 'security'], count: 2 })
  })

  test('a finding that points at a missing file never reaches the builder, and is kept as refuted', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider, seen } = reviewers(focus => (focus === 'logic' ? says(finding({ file: 'ghost.tsx' }), finding({ line: 5, problem: 'real one' })) : says()))
    await drive(runId, provider, dir, base)
    const builds = seen.filter(s => s.kind === 'build')
    expect(builds[1]!.note).toContain('real one')
    expect(builds[1]!.note).not.toContain('ghost.tsx')
    const rows = await findingsOf(runId)
    expect(rows.find(r => r.file === 'ghost.tsx')!.state).toBe('refuted')
  })

  test('when every finding is refuted the block passes and nobody is sent back', async () => {
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
  test('what was sent back counts as fixed, and what is left after the rounds allowed needs the person', async () => {
    const runId = await newRun()
    const { dir, base } = workdir(false)
    const { provider } = reviewers(focus => (focus === 'logic' ? says(finding({ problem: "still wrong" })) : says()))
    await drive(runId, provider, dir, base)
    const rows = await findingsOf(runId)
    expect(rows.map(r => r.state)).toEqual(['fixed_unchecked', 'fixed_unchecked', 'open'])
    const approve = await payloads(runId, 'node.completed', 'approve')
    expect(approve.at(-1)!.summary).toBe(strings.review.approve.summary({ found: 3, fixed: 2, discarded: 0, needsYou: 1 }))
  })

  test('the sentence reads plainly and leaves out what is zero', () => {
    expect(strings.review.approve.summary({ found: 3, fixed: 2, discarded: 0, needsYou: 1 })).toBe('3 problems found. 2 fixed, 1 needs you.')
    expect(strings.review.approve.summary({ found: 1, fixed: 0, discarded: 1, needsYou: 0 })).toBe('1 problem found. 1 discarded.')
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

import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { claims, evidence, nodeRuns, projects, questions, runs, usageRecords, workflows } from '@/db/schema'
import type { AskMode } from '@/domain/ask-mode'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { MAX_REPLANS, modeOf, orchestrateRun, type ExecutorDeps, type Plan, type StepApi } from '@/engine/inngest/execute-run'
import { PLAN_DECIDED, QUESTION_ANSWERED } from '@/engine/inngest/client'
import { decidePlan, type Job, type PlanQuestion } from '@/engine/plan'
import { answerQuestion, openQuestion, type Question } from '@/engine/questions'
import { recordDecision } from '@/engine/approvals'
import { addEntry, gateInputs, listRegister } from '@/engine/register'
import { clip, redact } from '@/engine/redact'
import { depthOf } from '@/engine/inngest/review-stage'
import { createProject } from '@/engine/projects'
import { createRunWorktree } from '@/engine/worktree'
import { cancelRun, createRun, publishVersion, saveDraft } from '@/engine/run'
import type { TestRun } from '@/engine/test-runner'
import type { AgentEvent, AgentProvider, BlockRoute } from '@/providers/types'
import { createClaudeProvider } from '@/providers/claude'
import { strings } from '@/ui/strings'

// M3a: a provider that works on files gets the run's worktree first; what it reports is stored by kind —
// evidence, usage and claims each in their own place — and nothing it prints reaches the log unredacted.

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

class Parked extends Error {}
const step: StepApi = {
  run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
  waitForEvent: async () => {
    throw new Parked()
  },
}

async function newRun(settings: { repoPath?: string | null; testCommand?: string | null; autoApproveLowRisk?: boolean } = {}): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({
    id: projectId, projectId, name: 'p', createdAt: now(),
    repoPath: settings.repoPath ?? null, testCommand: settings.testCommand ?? null, autoApproveLowRisk: settings.autoApproveLowRisk ?? false,
  })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'do it' })
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  return runId
}

type Script = Partial<Record<string, AgentEvent[]>>
function filesProvider(
  script: Script,
  route?: (kind: string) => BlockRoute,
): AgentProvider & { calls: { kind: string; workdir?: string; testCommand?: string | null; baseCommit?: string; revisionNote?: string }[] } {
  const calls: { kind: string; workdir?: string; testCommand?: string | null; baseCommit?: string; revisionNote?: string }[] = []
  return {
    id: 'files',
    isDemo: false,
    needsWorkspace: true,
    route: route ? kind => route(kind) : undefined,
    calls,
    async *execute(input) {
      calls.push({ kind: input.blockKind, workdir: input.workdir, testCommand: input.testCommand, baseCommit: input.baseCommit, revisionNote: input.revisionNote })
      // A reviewer that is not scripted answers as a real one does when it finds nothing: with a verdict.
      const fallback: AgentEvent[] = input.blockKind === 'review' ? [{ type: 'done', summary: 'ok', source: 'provider', review: { verdict: 'ok', findings: [] } }] : [{ type: 'done', summary: 'ok', source: 'system' }]
      for (const ev of script[input.blockKind] ?? fallback) yield ev
    },
  }
}

async function drive(runId: string, provider: AgentProvider, createWorktree: ExecutorDeps['createWorktree'] = (_repo, id) => ({ path: `/wt/${id}`, branch: `factory/${id}`, baseCommit: 'abc' }), more: Partial<ExecutorDeps> = {}) {
  try {
    await orchestrateRun(runId, step, { resolveProvider: () => provider, createWorktree, ...more })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
}

const node = async (runId: string, blockId: string) => (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === blockId)!
const payloadOf = async (runId: string, type: string, blockId?: string) =>
  (await eventsSince(runId, 0)).filter(e => e.type === type && (!blockId || (e.payload as { blockId?: string }).blockId === blockId)).map(e => e.payload as Record<string, unknown>)

test('the worktree is made before any block runs, and every block is handed its path and the test command', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const made = vi.fn((_repo: string, id: string) => ({ path: `/wt/${id}`, branch: `factory/${id}`, baseCommit: 'abc' }))
  const provider = filesProvider({})
  await drive(runId, provider, made)
  expect(made).toHaveBeenCalledWith('/repo', runId, undefined, 'do it') // no start point (from HEAD); the request names the branch
  const types = (await eventsSince(runId, 0)).map(e => e.type)
  expect(types.indexOf('run.workspace')).toBeLessThan(types.indexOf('node.started'))
  expect(await payloadOf(runId, 'run.workspace')).toEqual([{ branch: `factory/${runId}`, path: `/wt/${runId}`, baseCommit: 'abc' }])
  const row = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!
  expect([row.worktreePath, row.branch, row.baseCommit]).toEqual([`/wt/${runId}`, `factory/${runId}`, 'abc'])
  expect(provider.calls.every(c => c.workdir === `/wt/${runId}` && c.testCommand === 'npm test' && c.baseCommit === 'abc')).toBe(true)
})

test('a project with no repository fails the run before any agent starts, and says why', async () => {
  const runId = await newRun({ repoPath: null })
  const provider = filesProvider({})
  await drive(runId, provider)
  expect(provider.calls).toEqual([])
  expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('failed')
  expect(await payloadOf(runId, 'run.failed')).toEqual([{ cause: 'workspace_failed', message: strings.run.noRepository }])
})

test('a worktree that cannot be made fails the run with the reason, redacted', async () => {
  const runId = await newRun({ repoPath: '/repo' })
  const provider = filesProvider({})
  await drive(runId, provider, () => {
    throw new Error('fatal: not a git repository ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })
  expect(provider.calls).toEqual([])
  const [failed] = await payloadOf(runId, 'run.failed')
  expect(String(failed!.message)).toContain('not a git repository')
  expect(String(failed!.message)).not.toContain('ghp_')
})

test('a block the provider routes away is skipped with the provider\'s reason', async () => {
  const runId = await newRun({ repoPath: '/repo' })
  await drive(runId, filesProvider({}, kind => (kind === 'review' ? { mode: 'skip', reason: 'Not yet.' } : { mode: 'execute' })))
  expect((await node(runId, 'review')).state).toBe('skipped')
  expect(await payloadOf(runId, 'node.skipped', 'review')).toEqual([{ blockId: 'review', reason: 'Not yet.' }])
})

const testRun: TestRun = {
  command: 'npm test', exitCode: 1, signal: null, started: true, durationMs: 1234,
  counts: { passed: 3, failed: 1, total: 4 }, outputTail: 'FAIL src/a.test.ts', changedTestFiles: ['test/a.test.ts'],
}

test('evidence is stored whole in its own table, and the event carries numbers only', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  await drive(runId, filesProvider({ tests: [{ type: 'evidence', kind: 'test_run', data: testRun }, { type: 'done', summary: 'x', source: 'system' }] }))
  const rows = (await db.select().from(evidence).where(eq(evidence.runId, runId)))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.source).toBe('test-runner')
  expect(JSON.parse(rows[0]!.dataJson)).toEqual(testRun)
  expect(await payloadOf(runId, 'node.evidence', 'tests')).toEqual([
    {
      blockId: 'tests', kind: 'test_run', exitCode: 1, signal: null, durationMs: 1234,
      counts: { passed: 3, failed: 1, total: 4 }, changedTestFiles: ['test/a.test.ts'], changedTestFilesCount: 1,
    },
  ])
  expect(JSON.stringify(await eventsSince(runId, 0))).not.toContain('FAIL src/a.test.ts')
})

test('reported tokens are stored with cost not reported, and a model\'s sentence becomes a claim', async () => {
  const runId = await newRun({ repoPath: '/repo' })
  await drive(runId, filesProvider({ build: [{ type: 'done', summary: 'Made it blue.', source: 'provider', usage: { tokens: 1200 } }] }))
  const build = (await node(runId, 'build'))
  expect((await db.select().from(usageRecords).where(eq(usageRecords.nodeRunId, build.id))).map(u => [u.tokens, u.costCents])).toEqual([[1200, null]])
  expect((await db.select().from(claims).where(eq(claims.nodeRunId, build.id))).map(c => c.text)).toEqual(['Made it blue.'])
  expect(await payloadOf(runId, 'node.completed', 'build')).toEqual([{ blockId: 'build', summary: 'Made it blue.', summarySource: 'provider', attempt: 1, tokens: 1200 }])
  // A sentence the app composed is not a claim.
  expect((await db.select().from(claims).where(eq(claims.nodeRunId, (await node(runId, 'input')).id)))).toEqual([])
})

test('every step is redacted and clipped before it is logged', async () => {
  const runId = await newRun({ repoPath: '/repo' })
  await drive(runId, filesProvider({ build: [{ type: 'step', text: `Running: export API_KEY=supersecret123 ${'y'.repeat(400)}` }, { type: 'done', summary: 'ok' }] }))
  const [stepPayload] = await payloadOf(runId, 'node.step', 'build')
  expect(String(stepPayload!.text)).not.toContain('supersecret123')
  expect(String(stepPayload!.text).length).toBeLessThanOrEqual(240)
})

test('failing tests are recorded as the system\'s words and are not run a second time', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const provider = filesProvider({ tests: [{ type: 'error', message: '3 of 4 passed. 1 failed.', source: 'system', cause: 'tests_failed' }] })
  await drive(runId, provider)
  expect(provider.calls.filter(c => c.kind === 'tests')).toHaveLength(1)
  expect((await node(runId, 'tests')).state).toBe('failed')
  const [failed] = await payloadOf(runId, 'node.failed', 'tests')
  expect(failed).toMatchObject({ cause: 'tests_failed', messageSource: 'system', message: '3 of 4 passed. 1 failed.' })
})

test('the text of an exception a provider throws is redacted before it is logged', async () => {
  const runId = await newRun({ repoPath: '/repo' })
  const throwing: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      if (input.blockKind === 'build') throw new Error('crashed reading API_KEY=hunter2hunter2 ghp_abcdefghijklmnopqrstuvwxyz0123456789')
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  await drive(runId, throwing)
  const logged = JSON.stringify(await eventsSince(runId, 0))
  expect(logged).toContain('crashed reading')
  expect(logged).not.toContain('hunter2hunter2')
  expect(logged).not.toContain('ghp_')
})

test('evidence commits together with the block\'s ending: a block that never ends records no measurement', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      if (input.blockKind === 'tests') {
        yield { type: 'evidence', kind: 'test_run', data: testRun }
        await cancelRun(runId) // the person cancels between the measurement and the result
        yield { type: 'error', message: 'x', source: 'system', cause: 'tests_failed' }
        return
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  await drive(runId, provider)
  expect((await node(runId, 'tests')).state).toBe('cancelled')
  expect((await db.select().from(evidence).where(eq(evidence.runId, runId)))).toEqual([])
  expect(await payloadOf(runId, 'node.evidence')).toEqual([])
})

// ---- the human check, measured -----------------------------------------------------------------------------------

/** A real repository whose worktree holds `changes` on top of one commit, standing in for the run's worktree. */
function realWorktree(changes: Record<string, string>): ExecutorDeps['createWorktree'] {
  const dir = mkdtempSync(join(tmpdir(), 'factory-gate-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  const write = (p: string, body: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  git('init', '-q')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  write('src/app/page.tsx', 'one\ntwo\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const baseCommit = git('rev-parse', 'HEAD')
  for (const [p, body] of Object.entries(changes)) write(p, body)
  return () => ({ path: dir, branch: 'factory/x', baseCommit })
}

const passingTests: TestRun = { ...testRun, exitCode: 0, counts: { passed: 4, failed: 0, total: 4 }, changedTestFiles: [] }
const withTests = (data: TestRun = passingTests) =>
  filesProvider({ tests: [{ type: 'evidence', kind: 'test_run', data }, { type: 'done', summary: 'x', source: 'system' }] })

test('with the switch on, a small, measured-safe change passes the human check on its own and the run goes on', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  await drive(runId, withTests(), realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }))
  expect((await node(runId, 'human')).state).toBe('passed')
  expect(await payloadOf(runId, 'node.assessed', 'human')).toMatchObject([{ level: 'low', filesCount: 1, linesChanged: 2 }])
  expect(await payloadOf(runId, 'node.completed', 'human')).toMatchObject([{ summary: strings.risk.passedLow, summarySource: 'system', autoApproved: true }])
  expect((await node(runId, 'ship')).state).not.toBe('queued')
})

test('with the switch off, the same change still stops for the person, with the measurement on record', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: false })
  await drive(runId, withTests(), realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }))
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
  expect(await payloadOf(runId, 'node.assessed', 'human')).toMatchObject([{ level: 'low' }])
})

test('a change to something sensitive stops for the person even with the switch on, and says what', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  await drive(runId, withTests(), realWorktree({ 'src/lib/stripe.ts': 'charge()\n' }))
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
  const [assessed] = await payloadOf(runId, 'node.assessed', 'human')
  expect(assessed!.level).toBe('high')
  expect(String(assessed!.reasons)).toContain('src/lib/stripe.ts')
})

test('a change inside a core area the person marked stops for them even with the switch on, and says where', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  const projectId = (await db.select({ p: runs.projectId }).from(runs).where(eq(runs.id, runId)))[0]!.p
  await addEntry(projectId, { kind: 'core', text: 'Ask me before changing src/app/', paths: ['src/app/'], source: 'person' })
  await drive(runId, withTests(), realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }))
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
  const [assessed] = await payloadOf(runId, 'node.assessed', 'human')
  expect(assessed!.level).toBe('high')
  expect(assessed!.reasons).toEqual(['src/app/page.tsx is inside src/app/, which you marked as a core area.'])
})

test('a change on files one of the person\'s decisions names stops for them in the default mode, and says which decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir })
  const { projectId, workflowId } = await createProject({ path: dir, name: 'Shop', testCommand: 'npm test', checks: [] })
  expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]!.askMode).toBe('what_matters')
  await addEntry(projectId, { kind: 'decision', text: 'Prices round down', paths: ['src/rounding/'], source: 'question' })
  const { runId } = await createRun({ workflowId, request: 'do it' })
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  const worktree = realWorktree({ 'src/rounding/round.ts': 'floor()\n' })
  await drive(runId, withTests(), worktree)
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
  const [assessed] = await payloadOf(runId, 'node.assessed', 'human')
  expect(assessed!.level).toBe('high')
  // The review depth reads the same register the gate does, so the two say the same about the same change.
  const made = worktree!('', runId)
  const workspace = { workdir: made.path, baseCommit: made.baseCommit } as Parameters<typeof depthOf>[1]
  expect(await depthOf(runId, workspace)).toBe('high')
  expect(await depthOf(runId, workspace, { paths: ['src/rounding/round.ts'], diff: '', files: [{ path: 'src/rounding/round.ts', lines: 1 }], more: 0 })).toBe('high')
  expect(assessed!.reasons).toEqual([strings.risk.onDecision('src/rounding/round.ts', 'Prices round down')])
  expect(await payloadOf(runId, 'node.completed', 'human')).toEqual([])
})

test('a reviewer whose answer could not be read holds the human check for the person, and says so', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  const provider = filesProvider({
    tests: [{ type: 'evidence', kind: 'test_run', data: passingTests }, { type: 'done', summary: 'x', source: 'system' }],
    review: [{ type: 'done', summary: strings.review.unreadable, source: 'system' }],
  })
  await drive(runId, provider, realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }))
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
  const [assessed] = await payloadOf(runId, 'node.assessed', 'human')
  expect(assessed!.level).toBe('high')
  expect(assessed!.reasons).toContain(strings.risk.reviewUnreadable)
})

test('with no tests run, nothing is low risk, even a one-line change', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: null, autoApproveLowRisk: true })
  await drive(runId, filesProvider({}), realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }))
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
  expect(String((await payloadOf(runId, 'node.assessed', 'human'))[0]!.reasons)).toContain(strings.risk.noTests)
})

test('a run whose tests changed stops for the person', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  await drive(runId, withTests({ ...passingTests, changedTestFiles: ['test/a.test.ts'] }), realWorktree({ 'src/app/page.tsx': 'x\n' }))
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
})

// ---- asking for changes: the return loop ----------------------------------------------------------------------

/** Hands out the person's decisions in order, recording each the way the app does before the event arrives. */
function decisionsStep(runId: string, queue: { decision: 'approved' | 'rejected' | 'changes'; note?: string }[]): StepApi {
  return {
    run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
    waitForEvent: async () => {
      const next = queue.shift()
      if (!next) throw new Parked()
      await recordDecision(runId, next.decision, { actor: 'tester', reason: next.note ?? null, diffHash: null })
      return { data: { decision: next.decision } }
    },
  }
}

test('asking for changes sends the work back to the builder with the note, re-tests, and stops again for the person', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const provider = withTests()
  try {
    await orchestrateRun(runId, decisionsStep(runId, [{ decision: 'changes', note: 'make the border thicker' }]), {
      resolveProvider: () => provider,
      createWorktree: realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }),
    })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  const builds = provider.calls.filter(c => c.kind === 'build')
  expect(builds).toHaveLength(2)
  expect(builds[1]!.revisionNote).toBe('make the border thicker')
  expect(builds[0]!.revisionNote).toBeUndefined()
  expect(builds[1]!.workdir).toBe(builds[0]!.workdir) // the same worktree: round 2 builds on round 1
  expect(provider.calls.filter(c => c.kind === 'tests')).toHaveLength(2)
  const reopened = await payloadOf(runId, 'node.reopened')
  expect(reopened.map(p => p.blockId)).toEqual(['build', 'tests', 'review', 'approve', 'human'])
  expect(reopened.every(p => p.round === 2 && p.note === 'make the border thicker')).toBe(true)
  // Stopped again, for a decision on round 2.
  expect((await node(runId, 'human')).state).toBe('waiting_approval')
  expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('waiting_approval')
})

test('after a round of changes, an approval finishes the run; the earlier "changes" is not read twice', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const provider = withTests()
  await orchestrateRun(runId, decisionsStep(runId, [{ decision: 'changes', note: 'thicker' }, { decision: 'approved' }]), {
    resolveProvider: () => provider,
    createWorktree: realWorktree({ 'src/app/page.tsx': 'x\n' }),
  })
  expect((await node(runId, 'human')).state).toBe('passed')
  expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('completed')
  expect(provider.calls.filter(c => c.kind === 'build')).toHaveLength(2)
})

test('a failing test in round 1 does not count against round 2 once it passes', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  let testRuns = 0
  const provider: AgentProvider & { calls: unknown[] } = {
    id: 'files', isDemo: false, needsWorkspace: true, calls: [],
    async *execute(input) {
      if (input.blockKind === 'tests') {
        testRuns++
        // Round 1 passes but changes a test (so the gate stops); round 2 passes cleanly.
        const data = testRuns === 1 ? { ...passingTests, changedTestFiles: ['test/a.test.ts'] } : passingTests
        yield { type: 'evidence', kind: 'test_run', data }
      }
      if (input.blockKind === 'review') {
        yield { type: 'done', summary: 'ok', source: 'provider', review: { verdict: 'ok', findings: [] } }
        return
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  try {
    await orchestrateRun(runId, decisionsStep(runId, [{ decision: 'changes', note: 'leave the tests alone' }]), {
      resolveProvider: () => provider,
      createWorktree: realWorktree({ 'src/app/page.tsx': 'x\n' }),
    })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  // Round 2 measured low on its own latest test run, and the switch is on, so it passed by itself.
  const assessed = await payloadOf(runId, 'node.assessed', 'human')
  expect(assessed.map(a => a.level)).toEqual(['high', 'low'])
  expect((await node(runId, 'human')).state).toBe('passed')
})

test('round 1 is handed the request\'s images; a round of changes gets only the images sent with it', async () => {
  const { saveAttachment, claimAttachments } = await import('@/engine/attachments')
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  const imgDir = mkdtempSync(join(tmpdir(), 'factory-img-'))
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const first = (await saveAttachment('mock.png', png, imgDir))
  await claimAttachments([first.id], runId)
  const provider = withTests()
  const imagesSeen: (string[] | undefined)[] = []
  const recording: AgentProvider = {
    ...provider,
    async *execute(input, controls) {
      if (input.blockKind === 'build') imagesSeen.push(input.images)
      yield* provider.execute(input, controls)
    },
  }
  const step = decisionsStep(runId, [{ decision: 'changes', note: 'like this one' }])
  const original = step.waitForEvent
  step.waitForEvent = async (...args) => {
    // The request for changes comes with its own image, attached to that decision.
    const result = await original(...args)
    const { approvals } = await import('@/db/schema')
    const decision = (await db.select().from(approvals).where(eq(approvals.runId, runId))).at(-1)!
    const second = (await saveAttachment('better.png', png, imgDir))
    await claimAttachments([second.id], runId, decision.id)
    return result
  }
  try {
    await orchestrateRun(runId, step, { resolveProvider: () => recording, createWorktree: realWorktree({ 'src/app/page.tsx': 'x\n' }) })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  expect(imagesSeen).toHaveLength(2)
  expect(imagesSeen[0]).toEqual([join(imgDir, `${first.id}.png`)])
  expect(imagesSeen[1]).toHaveLength(1)
  expect(imagesSeen[1]![0]).not.toBe(imagesSeen[0]![0])
})

test('the model written on the Build block, as frozen in the run, reaches the builder', async () => {
  const { workflowVersions } = await import('@/db/schema')
  const runId = await newRun({ repoPath: '/repo' })
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]!
  const graph = JSON.parse(version.graphJson) as { blocks: { kind: string; config: Record<string, unknown> }[] }
  graph.blocks.find(b => b.kind === 'build')!.config.model = 'opus'
  await db.update(workflowVersions).set({ graphJson: JSON.stringify(graph) }).where(eq(workflowVersions.id, version.id))
  const models: (string | undefined)[] = []
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      models.push(`${input.blockKind}:${input.model ?? '-'}`)
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  await drive(runId, provider)
  expect(models).toContain('build:opus')
  expect(models).toContain('tests:-') // a block with no model set gets none: the agent's default
})

test('a Build block with a model per area builds with the one for what the request is about, and says so', async () => {
  const { workflowVersions } = await import('@/db/schema')
  const { strings } = await import('@/ui/strings')
  const runId = await newRun({ repoPath: '/repo' })
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]!
  const graph = JSON.parse(version.graphJson) as { blocks: { kind: string; config: Record<string, unknown> }[] }
  Object.assign(graph.blocks.find(b => b.kind === 'build')!.config, { model: 'opus', modelFrontend: 'sonnet', modelBackend: 'opus' })
  await db.update(workflowVersions).set({ graphJson: JSON.stringify(graph) }).where(eq(workflowVersions.id, version.id))
  const models: string[] = []
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      models.push(`${input.blockKind}:${input.model ?? '-'}`)
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  const asked: string[] = []
  try {
    await orchestrateRun(runId, step, {
      resolveProvider: () => provider,
      createWorktree: (_r, id) => ({ path: `/wt/${id}`, branch: `factory/${id}`, baseCommit: 'abc' }),
      classifyArea: async r => (asked.push(r), 'frontend'),
    })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  expect(asked).toHaveLength(1)
  expect(models).toContain('build:sonnet')
  const steps = (await payloadOf(runId, 'node.step', 'build')).map(p => p.text)
  expect(steps[0]).toBe(strings.routing.note('front end', 'sonnet'))
})

test('without per-area models the request is not read for routing', async () => {
  const runId = await newRun({ repoPath: '/repo' })
  let asked = false
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute() {
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  try {
    await orchestrateRun(runId, step, {
      resolveProvider: () => provider,
      createWorktree: (_r, id) => ({ path: `/wt/${id}`, branch: `factory/${id}`, baseCommit: 'abc' }),
      classifyArea: async () => ((asked = true), 'backend'),
    })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  expect(asked).toBe(false)
})

test('each Tests block runs its own command, and one without falls back to the project command', async () => {
  const { workflowVersions } = await import('@/db/schema')
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]!
  const graph = JSON.parse(version.graphJson) as { blocks: { id: string; kind: string; label: string; enabled: boolean; config: Record<string, unknown>; position: { x: number; y: number } }[] }
  graph.blocks.push({ id: 'tests-1', kind: 'tests', label: 'Lint', enabled: true, config: { testCommand: '  npm run lint ' }, position: { x: 0, y: 1 } })
  await db.update(workflowVersions).set({ graphJson: JSON.stringify(graph) }).where(eq(workflowVersions.id, version.id))
  const commands: string[] = []
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      if (input.blockKind === 'tests') commands.push(String(input.testCommand))
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  await drive(runId, provider)
  expect(commands).toEqual(['npm test', 'npm run lint'])
})

test('dependencies are installed once in the copy, before the builder, and the card says so', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  const { strings } = await import('@/ui/strings')
  const copy = mkdtempSync(j(tmpdir(), 'factory-copy-'))
  writeFileSync(j(copy, 'package.json'), '{}')
  writeFileSync(j(copy, 'pnpm-lock.yaml'), '')
  const runId = await newRun({ repoPath: '/repo' })
  const order: string[] = []
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      order.push(input.blockKind)
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  try {
    await orchestrateRun(runId, step, {
      resolveProvider: () => provider,
      createWorktree: () => ({ path: copy, branch: 'ai/x', baseCommit: 'abc' }),
      installDependencies: async dir => (order.push(`install:${dir === copy}`), { command: 'pnpm install', ok: true, durationMs: 2400, outputTail: '' }),
    })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  expect(order.filter(o => o.startsWith('install'))).toEqual(['install:true'])
  expect(order.indexOf('install:true')).toBeLessThan(order.indexOf('build'))
  const steps = (await payloadOf(runId, 'node.step', 'build')).map(p => p.text)
  expect(steps[0]).toBe(strings.run.installing('pnpm install --frozen-lockfile --prefer-offline'))
  expect(steps[1]).toBe(strings.run.installed(2))
})

describe('the reviewer', () => {
  function reviewingProvider(verdicts: ('ok' | 'changes')[], seen: { kind: string; model?: string; from?: string; note?: string }[]): AgentProvider {
    let reviews = 0
    return {
      id: 'files', isDemo: false, needsWorkspace: true,
      async *execute(input) {
        seen.push({ kind: input.blockKind, model: input.model, from: input.revisionFrom, note: input.revisionNote })
        if (input.blockKind === 'review') {
          // The first reader of a round decides what it says; the others find nothing.
          if (input.focus !== 'logic') {
            yield { type: 'done', summary: 'ok', source: 'provider', review: { verdict: 'ok', findings: [] } }
            return
          }
          const verdict = verdicts[Math.min(reviews++, verdicts.length - 1)]!
          const review = verdict === 'ok' ? { verdict, findings: [] } : { verdict, findings: [{ type: 'logic' as const, file: 'a.tsx', line: 3, problem: 'wrong colour', severity: 'medium' as const, affects: [], decisions: [] }] }
          yield { type: 'done', summary: verdict, source: 'provider', review }
          return
        }
        yield { type: 'done', summary: 'ok', source: 'system' }
      },
    }
  }

  // The findings are checked against the copy, so it must hold the file they point at.
  const copyWithFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-reviewed-'))
    writeFileSync(join(dir, 'a.tsx'), 'one\ntwo\nthree\n')
    return (_repo: string, id: string) => ({ path: dir, branch: `factory/${id}`, baseCommit: 'abc' })
  }

  // The verifier's copy is a folder of its own, and the reproduction is never run for real here.
  const noCopy: Partial<ExecutorDeps> = { makeCopy: async () => mkdtempSync(join(tmpdir(), 'factory-verify-')) }

  test('a problem is checked, not sent back to Build; with nothing to show it, Approve says it was discarded', async () => {
    const { strings } = await import('@/ui/strings')
    const runId = await newRun({ repoPath: '/repo' })
    const seen: { kind: string; model?: string; from?: string; note?: string }[] = []
    await drive(runId, reviewingProvider(['changes'], seen), copyWithFile(), noCopy)
    expect(seen.filter(s => s.kind === 'build')).toHaveLength(1)
    expect((await payloadOf(runId, 'node.reopened')).length).toBe(0)
    // A different model from the builder's default.
    expect(seen.find(s => s.kind === 'review')!.model).toBe('sonnet')
    expect(seen.some(s => s.kind === 'approve')).toBe(false) // summed up by the app, not run by the agent
    const approve = await payloadOf(runId, 'node.completed', 'approve')
    expect(approve.at(-1)!.summary).toBe(strings.review.approve.noneWasReal(1))
    expect((await node(runId, 'human')).state).toBe('waiting_approval')
  })

  test('a clean review lets Approve say so', async () => {
    const { strings } = await import('@/ui/strings')
    const runId = await newRun({ repoPath: '/repo' })
    await drive(runId, reviewingProvider(['ok'], []), copyWithFile(), noCopy)
    const approve = await payloadOf(runId, 'node.completed', 'approve')
    expect(approve.at(-1)!.summary).toBe(strings.review.approve.clean)
  })
})

test('a copy whose lockfile matches the prepared base gets its dependencies by copy, and nothing is installed', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  const { strings } = await import('@/ui/strings')
  const copy = mkdtempSync(j(tmpdir(), 'factory-copy-'))
  writeFileSync(j(copy, 'package.json'), '{}')
  writeFileSync(j(copy, 'pnpm-lock.yaml'), '')
  const runId = await newRun({ repoPath: '/repo' })
  let installed = false
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute() {
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  try {
    await orchestrateRun(runId, step, {
      resolveProvider: () => provider,
      createWorktree: () => ({ path: copy, branch: 'ai/x', baseCommit: 'abc' }),
      installDependencies: async () => ((installed = true), null),
      copyBase: async () => ({ copied: true, ms: 800 }),
    })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  expect(installed).toBe(false)
  expect((await payloadOf(runId, 'node.step', 'build')).map(p => p.text)[0]).toBe(strings.run.copiedFromBase(1))
})

// ---- the plan, measured, and the project's ask mode ----------------------------------------------------------------

describe('the plan follows the project\'s ask mode', () => {
  /** A project made the way the app makes one, on a real folder with one commit, and a task in it. */
  async function projectRun(opts: { askMode?: AskMode; stopForMe?: boolean } = {}): Promise<{ runId: string; projectId: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ask-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir })
    const { projectId, workflowId } = await createProject({ path: dir, name: 'Shop', testCommand: 'npm test', checks: [], ...(opts.askMode ? { askMode: opts.askMode } : {}) })
    const { runId } = await createRun({ workflowId, request: 'add a footer', ...(opts.stopForMe ? { stopForMe: true } : {}) })
    await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
    return { runId, projectId }
  }

  const footer: Job[] = [{ title: 'Add the footer', done: ['shows the year'], paths: ['src/ui/footer/Footer.tsx'] }]
  const login: Job[] = [{ title: 'Change sign-in', done: [], paths: ['src/auth/login.ts'] }]
  const question: PlanQuestion = { text: 'Which sign-in?', why: '', paths: ['src/ui/footer/'], options: [{ id: 'a', label: 'Use username', means: 'A new field.' }, { id: 'b', label: 'Keep email', means: 'As today.' }] }

  type Planned = { jobs: Job[]; question?: PlanQuestion | 'unreadable' }
  /** The planner gives these answers in turn (the last one again once they run out); every other block passes. */
  function planner(answers: Planned[]): AgentProvider & { notes: (string | undefined)[]; built: (Job[] | undefined)[] } {
    const notes: (string | undefined)[] = []
    const built: (Job[] | undefined)[] = []
    let i = 0
    return {
      id: 'files', isDemo: false, needsWorkspace: true, notes, built,
      async *execute(input) {
        if (input.blockKind === 'plan') {
          notes.push(input.revisionNote)
          const a = answers[Math.min(i++, answers.length - 1)]!
          yield { type: 'done', summary: strings.plan.proposed(a.jobs.length), source: 'provider', plan: a.jobs, ...(a.question ? { planQuestion: a.question } : {}) }
          return
        }
        if (input.blockKind === 'build') built.push(input.jobs)
        if (input.blockKind === 'review') {
          yield { type: 'done', summary: 'ok', source: 'provider', review: { verdict: 'ok', findings: [] } }
          return
        }
        yield { type: 'done', summary: 'ok', source: 'system' }
      },
    }
  }

  /** Steps that remember their ids; a wait is answered by `on`, or parks the run when it has nothing to say. */
  function recordingStep(on: (event: string) => Promise<boolean> = async () => false): StepApi & { ids: string[]; waits: string[] } {
    const ids: string[] = []
    const waits: string[] = []
    return {
      ids, waits,
      run: async (id, fn) => (ids.push(id), JSON.parse(JSON.stringify((await fn()) ?? null))),
      waitForEvent: async (id, opts) => {
        waits.push(id)
        if (!(await on(opts.event))) throw new Parked()
        return { data: {} }
      },
    }
  }

  async function go(runId: string, provider: AgentProvider, s: StepApi, worktree: ExecutorDeps['createWorktree'] = (_repo, id) => ({ path: `/wt/${id}`, branch: `factory/${id}`, baseCommit: 'abc' })) {
    try {
      await orchestrateRun(runId, s, { resolveProvider: () => provider, createWorktree: worktree })
    } catch (e) {
      if (!(e instanceof Parked)) throw e
    }
  }
  const measured = (runId: string) => payloadOf(runId, 'node.plan_measured', 'plan')
  const planWaited = async (runId: string) => (await payloadOf(runId, 'run.waiting_approval')).filter(p => p.blockId === 'plan')

  test('a simple plan starts on its own in "only what matters"', async () => {
    const { runId } = await projectRun()
    const provider = planner([{ jobs: footer }])
    await go(runId, provider, recordingStep())
    expect((await node(runId, 'plan')).state).toBe('passed')
    expect(await payloadOf(runId, 'node.completed', 'plan')).toEqual([{ blockId: 'plan', summary: strings.plan.startedOnItsOwn, summarySource: 'system', autoStarted: true }])
    const [m] = await measured(runId)
    expect(m).toMatchObject({ simple: true, entries: ['src/ui/footer/Footer.tsx'], mode: 'what_matters', stopForMe: false })
    expect(await planWaited(runId)).toEqual([])
    expect(await payloadOf(runId, 'node.plan_proposed', 'plan')).toEqual([])
    expect(provider.built).toEqual([footer])
    // The plan the person did not have to check is still on the record, measured first.
    const types = (await eventsSince(runId, 0)).filter(e => e.type === 'node.plan_measured' || e.type === 'node.planned').map(e => e.type)
    expect(types).toEqual(['node.plan_measured', 'node.planned'])
  })

  test('the same plan stops in "ask me about everything", and says why first', async () => {
    const { runId } = await projectRun({ askMode: 'everything' })
    await go(runId, planner([{ jobs: footer }]), recordingStep())
    expect((await node(runId, 'plan')).state).toBe('waiting_approval')
    const [m] = await measured(runId)
    expect(m!.simple).toBe(true)
    expect((m!.reasons as string[])[0]).toBe(strings.plan.reasons.everything)
    expect((m!.reasons as string[])[1]).toBe(strings.plan.reasons.simple(1))
    expect(await planWaited(runId)).toHaveLength(1)
  })

  test('the same plan stops when the person asked the app to stop for them on this task', async () => {
    const { runId } = await projectRun({ stopForMe: true })
    await go(runId, planner([{ jobs: footer }]), recordingStep())
    expect((await node(runId, 'plan')).state).toBe('waiting_approval')
    const [m] = await measured(runId)
    expect(m).toMatchObject({ simple: true, stopForMe: true })
    expect((m!.reasons as string[])[0]).toBe(strings.plan.reasons.stopForMe)
  })

  test('the same plan stops in "small changes skip my final check"', async () => {
    const { runId } = await projectRun({ askMode: 'small_changes' })
    await go(runId, planner([{ jobs: footer }]), recordingStep())
    expect((await node(runId, 'plan')).state).toBe('waiting_approval')
    expect(((await measured(runId))[0]!.reasons as string[])[0]).toBe(strings.plan.reasons.smallChanges)
  })

  test('a sensitive plan stops and says why', async () => {
    const { runId } = await projectRun()
    await go(runId, planner([{ jobs: login }]), recordingStep())
    expect((await node(runId, 'plan')).state).toBe('waiting_approval')
    const [m] = await measured(runId)
    expect(m!.simple).toBe(false)
    expect((m!.reasons as string[])[0]).toBe(strings.plan.reasons.sensitive(strings.risk.areas.auth))
  })

  test('a plan the planner gave no paths for stops, as a plan whose files are not known', async () => {
    const { runId } = await projectRun()
    await go(runId, planner([{ jobs: [{ title: 'Add the footer', done: [] }] }]), recordingStep())
    expect((await node(runId, 'plan')).state).toBe('waiting_approval')
    expect(((await measured(runId))[0]!.reasons as string[])[0]).toBe(strings.plan.reasons.noPaths)
  })

  test('every new plan is measured again', async () => {
    const { runId } = await projectRun()
    const s = recordingStep(async event => {
      if (event !== PLAN_DECIDED) return false
      await decidePlan(runId, { action: 'replan', note: 'leave sign-in alone' })
      return true
    })
    const provider = planner([{ jobs: login }, { jobs: footer }])
    await go(runId, provider, s)
    expect(provider.notes).toEqual([undefined, 'leave sign-in alone'])
    expect((await measured(runId)).map(m => m.simple)).toEqual([false, true])
    expect((await node(runId, 'plan')).state).toBe('passed')
    expect((await payloadOf(runId, 'node.completed', 'plan')).at(-1)).toMatchObject({ autoStarted: true })
    // The second plan is its own step, on the id the plan loop gives it.
    expect(s.ids).toContain('node-plan-plan1')
    expect(s.waits[0]).toBe('plan-decided-plan-0')
    expect(provider.built).toEqual([footer])
  })

  describe('what the real planner is told after the person answers', () => {
    const asks = JSON.stringify({ jobs: footer, question })
    const plain = JSON.stringify({ jobs: footer })
    /** The claude provider's own planner, on a stand-in CLI that answers in turn; every prompt it was given is kept. */
    function claudePlanner(answers: string[]): AgentProvider & { prompts: string[] } {
      const prompts: string[] = []
      let i = 0
      const spawn = (_bin: string, args: string[]) => {
        prompts.push(args[args.indexOf('-p') + 1]!)
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, exitCode: null as number | null, signalCode: null })
        const result = answers[Math.min(i++, answers.length - 1)]!
        setTimeout(() => {
          child.stdout.end(`${JSON.stringify({ type: 'result', is_error: false, result })}\n`)
          child.exitCode = 0
          setTimeout(() => child.emit('close', 0), 5)
        }, 1)
        return child
      }
      const claude = createClaudeProvider({ spawn: spawn as never, snapshot: () => 'same', readCopyFile: () => null })
      const rest = planner([{ jobs: footer }])
      return {
        id: 'files', isDemo: false, needsWorkspace: true, prompts,
        execute: (input, controls) => (input.blockKind === 'plan' ? claude.execute(input, controls) : rest.execute(input, controls)),
      }
    }
    async function answered(a: { option: string; text?: string }) {
      const { runId } = await projectRun()
      const s = recordingStep(async event => {
        if (event !== QUESTION_ANSWERED) return false
        await answerQuestion((await openQuestion(runId))!.id, a, { send: async () => undefined })
        return true
      })
      const provider = claudePlanner([asks, plain])
      await go(runId, provider, s)
      expect(provider.prompts).toHaveLength(2)
      return provider.prompts[1]!
    }
    const said = (note: string) => strings.providers.claude.planPrompt('add a footer', undefined, note, 'answer')

    test('an option chosen', async () => {
      const prompt = await answered({ option: 'a' })
      const note = strings.providers.claude.answerNote(question.text, { option: 'chosen', label: 'Use username' }, null)
      expect(prompt).toContain(`\n\n${strings.providers.claude.answerLine(note)}\n\n`)
      expect(said(note)).toContain(strings.providers.claude.answerLine(note))
      expect(prompt).toContain('they chose "Use username". Plan the work with that.')
      expect(prompt).toContain('That question is settled: do not ask it again.')
      expect(prompt).not.toContain('They looked at an earlier plan')
      expect(prompt).not.toContain('left it to you')
    })

    test('an option chosen, with the person\'s words', async () => {
      const prompt = await answered({ option: 'a', text: 'only for new accounts' })
      expect(prompt).toContain(strings.providers.claude.answerNote(question.text, { option: 'chosen', label: 'Use username' }, 'only for new accounts'))
      expect(prompt).toContain('they chose "Use username". They added, in their own words: only for new accounts')
      expect(prompt).not.toContain('They looked at an earlier plan')
    })

    test('the person\'s own words only: the words are the answer', async () => {
      const prompt = await answered({ option: 'other', text: 'use both, email first' })
      expect(prompt).toContain(strings.providers.claude.answerNote(question.text, { option: 'own' }, 'use both, email first'))
      expect(prompt).toContain(`The person answered your question "${question.text}" in their own words: use both, email first`)
      expect(prompt).not.toContain('left it to you')
      expect(prompt).not.toContain('They looked at an earlier plan')
    })

    test('left to the planner, with or without words', async () => {
      const bare = await answered({ option: 'leave' })
      expect(bare).toContain(strings.providers.claude.answerNote(question.text, { option: 'leave' }, null))
      expect(bare).toContain('they left it to you: choose what you think is best.')
      const withWords = await answered({ option: 'leave', text: 'whatever is simplest' })
      expect(withWords).toContain(strings.providers.claude.answerNote(question.text, { option: 'leave' }, 'whatever is simplest'))
      expect(withWords).toContain('They added, in their own words: whatever is simplest')
      expect(withWords).not.toContain('They looked at an earlier plan')
    })

    test('asking for another plan is still said as before', async () => {
      const { runId } = await projectRun({ askMode: 'everything' })
      const s = recordingStep(async event => {
        if (event !== PLAN_DECIDED) return false
        await decidePlan(runId, { action: 'replan', note: 'do it in one job' })
        return true
      })
      const provider = claudePlanner([plain])
      await go(runId, provider, s)
      expect(provider.prompts[1]).toContain('\n\nThey looked at an earlier plan and asked for this instead: do it in one job\n\n')
      expect(provider.prompts[1]).not.toContain('settled')
    })
  })

  test('the planner\'s question is asked, and the answer goes to the next plan', async () => {
    const { runId } = await projectRun()
    let asked: Question | null = null
    const s = recordingStep(async event => {
      if (event !== QUESTION_ANSWERED) return false
      asked = await openQuestion(runId)
      expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('waiting_approval')
      // A word on a plan is not taken while the planner's question waits.
      await expect(decidePlan(runId, { action: 'build', jobs: footer })).rejects.toThrow(strings.plan.answerFirst)
      await answerQuestion(asked!.id, { option: 'a' }, { send: async () => undefined })
      return true
    })
    const provider = planner([{ jobs: footer, question }, { jobs: footer }])
    await go(runId, provider, s)
    expect(asked).toMatchObject({ kind: 'plan', findingId: null, text: question.text, why: strings.plan.questionWhy })
    expect((await measured(runId))[0]).toMatchObject({ question: { text: question.text } })
    expect('question' in (await measured(runId))[1]!).toBe(false)
    expect(asked!.options.map(o => o.id)).toEqual(['a', 'b', 'leave'])
    expect(asked!.options.at(-1)).toEqual({ id: 'leave', label: strings.plan.leaveLabel, means: strings.plan.leaveMeans })
    expect(await payloadOf(runId, 'node.question_asked', 'plan')).toMatchObject([{ kind: 'plan', questionId: asked!.id }])
    const planned = (await eventsSince(runId, 0)).filter(e => ['node.planned', 'node.question_asked'].includes(e.type)).map(e => e.type)
    expect(planned.slice(0, 2)).toEqual(['node.planned', 'node.question_asked'])
    expect(provider.notes).toEqual([undefined, strings.providers.claude.answerNote(question.text, { option: 'chosen', label: 'Use username' }, null)])
    // Taken once, and the next plan, with no question and simple, starts on its own.
    expect((await db.select().from(questions).where(eq(questions.id, asked!.id)))[0]!.consumedAt).not.toBeNull()
    expect((await node(runId, 'plan')).state).toBe('passed')
    expect((await payloadOf(runId, 'node.completed', 'plan')).at(-1)).toMatchObject({ autoStarted: true })
    expect(s.ids).toContain('ask-plan-plan')
    expect(s.ids).toContain('node-plan-plan1')
    expect(s.waits[0]).toBe(`question-plan-${asked!.id}-0`)
    expect(provider.built).toEqual([footer])
  })

  test('leaving the planner\'s question to it says so in the note', async () => {
    const { runId } = await projectRun()
    const s = recordingStep(async event => {
      if (event !== QUESTION_ANSWERED) return false
      await answerQuestion((await openQuestion(runId))!.id, { option: 'leave', text: 'whatever is simplest' }, { send: async () => undefined })
      return true
    })
    const provider = planner([{ jobs: footer, question }, { jobs: footer }])
    await go(runId, provider, s)
    expect(provider.notes[1]).toBe(strings.providers.claude.answerNote(question.text, { option: 'leave' }, 'whatever is simplest'))
  })

  test('a question on the last plan allowed is not asked: the plan stops and says the planner needs the person', async () => {
    const { runId } = await projectRun()
    const s = recordingStep(async event => {
      if (event !== QUESTION_ANSWERED) return false
      await answerQuestion((await openQuestion(runId))!.id, { option: 'b' }, { send: async () => undefined })
      return true
    })
    const provider = planner([{ jobs: footer, question }])
    await go(runId, provider, s)
    expect(await db.select().from(questions).where(eq(questions.runId, runId))).toHaveLength(MAX_REPLANS)
    expect(provider.notes).toHaveLength(MAX_REPLANS + 1)
    expect((await node(runId, 'plan')).state).toBe('waiting_approval')
    expect(await openQuestion(runId)).toBeNull()
    expect(((await measured(runId)).at(-1)!.reasons as string[])[0]).toBe(strings.plan.reasons.asks)
  })

  test('a question that could not be read stops the plan', async () => {
    const { runId } = await projectRun()
    await go(runId, planner([{ jobs: footer, question: 'unreadable' }]), recordingStep())
    expect((await node(runId, 'plan')).state).toBe('waiting_approval')
    expect(await db.select().from(questions).where(eq(questions.runId, runId))).toHaveLength(0)
    expect(((await measured(runId))[0]!.reasons as string[])[0]).toBe(strings.plan.reasons.questionUnreadable)
  })

  test('a planner answer with no usable plan is not measured: Build works from the request, as before', async () => {
    const { runId } = await projectRun()
    const provider = filesProvider({ plan: [{ type: 'done', summary: strings.plan.unreadable, source: 'system' }] })
    await go(runId, provider, recordingStep())
    expect((await node(runId, 'plan')).state).toBe('passed')
    expect(await measured(runId)).toEqual([])
    expect(await payloadOf(runId, 'node.completed', 'plan')).toMatchObject([{ summary: strings.plan.unreadable }])
  })

  describe('a decision the person made on this run does not stop it again', () => {
    const rounding: Job[] = [{ title: 'Round the price', done: [], paths: ['src/rounding/round.ts'] }]
    const roundQ: PlanQuestion = { text: 'Round up or down?', why: '', paths: ['src/rounding/'], options: [{ id: 'a', label: 'Up', means: 'Ceil.' }, { id: 'b', label: 'Down', means: 'Floor.' }] }
    const authQ: PlanQuestion = { ...roundQ, text: 'Which sign-in?', paths: ['src/auth/'] }
    const words = 'down, always, for every price'
    /** The planner gives `answers`; the tests pass with their evidence, so a small change can pass the final check. */
    function planned(answers: Planned[]): AgentProvider & { notes: (string | undefined)[] } {
      const p = planner(answers)
      const t = withTests()
      return { ...p, execute: (input, c) => (input.blockKind === 'plan' ? p.execute(input, c) : t.execute(input, c)) }
    }
    /** Answers the planner's question in the person's own words, and builds a plan that stops. */
    const person = (runId: string) =>
      recordingStep(async event => {
        if (event === QUESTION_ANSWERED) await answerQuestion((await openQuestion(runId))!.id, { option: 'other', text: words }, { send: async () => undefined })
        else if (event === PLAN_DECIDED) await decidePlan(runId, { action: 'build', jobs: rounding })
        else return false
        return true
      })
    const decisionText = () => strings.question.decision({ about: strings.question.about('plan', undefined, roundQ.text), choice: null, words })

    test('the next plan on those files starts on its own, and the change passes the final check; a new run on the project stops twice', async () => {
      const { runId, projectId } = await projectRun()
      await go(runId, planned([{ jobs: rounding, question: roundQ }, { jobs: rounding }]), person(runId), realWorktree({ 'src/rounding/round.ts': 'floor()\n' }))
      const [decision] = (await listRegister(projectId)).filter(e => e.kind === 'decision')
      expect(decision).toMatchObject({ text: decisionText(), paths: ['src/rounding/'], source: 'question', runId })
      // (a) The plan after the answer is simple, and its reasons do not name the decision.
      const second = (await measured(runId)).at(-1)!
      expect(second.simple).toBe(true)
      expect(JSON.stringify(second.reasons)).not.toContain(words)
      expect((await payloadOf(runId, 'node.completed', 'plan')).at(-1)).toMatchObject({ autoStarted: true })
      // (b) The finished change on that file passes on its own.
      expect((await node(runId, 'human')).state).toBe('passed')
      expect(await payloadOf(runId, 'node.completed', 'human')).toMatchObject([{ autoApproved: true }])

      // (c) A new run on the same project: the decision is an earlier one now, so it stops at the plan and at the final check.
      const workflowId = (await db.select().from(workflows).where(eq(workflows.projectId, projectId)))[0]!.id
      const { runId: next } = await createRun({ workflowId, request: 'round the tax too' })
      await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, next))
      await go(next, planned([{ jobs: rounding }]), person(next), realWorktree({ 'src/rounding/round.ts': 'floor()\n' }))
      const [m] = await measured(next)
      expect(m!.simple).toBe(false)
      expect(m!.reasons).toContain(strings.plan.reasons.decision(decisionText()))
      expect((await node(next, 'human')).state).toBe('waiting_approval')
      const [assessed] = await payloadOf(next, 'node.assessed', 'human')
      expect(assessed!.level).toBe('high')
      expect(assessed!.reasons).toContain(strings.risk.onDecision('src/rounding/round.ts', decisionText()))
    })

    test('a decision from an earlier run still counts for this run, and the three readers read the same', async () => {
      const { runId, projectId } = await projectRun()
      const workflowId = (await db.select().from(workflows).where(eq(workflows.projectId, projectId)))[0]!.id
      const { runId: earlier } = await createRun({ workflowId, request: 'earlier' })
      // Written the way answerQuestion writes it, once on the earlier run and once on this one.
      await addEntry(projectId, { kind: 'decision', text: 'Prices round down', paths: ['src/rounding/'], source: 'question', runId: earlier })
      await addEntry(projectId, { kind: 'decision', text: 'Taxes round up', paths: ['src/tax/'], source: 'question', runId })
      expect((await gateInputs(projectId, db, runId)).decisions.map(d => d.text)).toEqual(['Prices round down'])
      expect((await gateInputs(projectId)).decisions.map(d => d.text)).toEqual(['Prices round down', 'Taxes round up'])
      await go(runId, planned([{ jobs: rounding }]), recordingStep())
      expect((await measured(runId))[0]!.reasons).toContain(strings.plan.reasons.decision('Prices round down'))
      expect((await node(runId, 'plan')).state).toBe('waiting_approval')
      // The review's depth reads the same: this run's own decision does not make its change high.
      const made = realWorktree({ 'src/tax/vat.ts': 'up()\n' })!('', runId)
      const workspace = { workdir: made.path, baseCommit: made.baseCommit } as Parameters<typeof depthOf>[1]
      await db.insert(evidence).values({ id: ulid(), projectId, runId, nodeRunId: (await node(runId, 'plan')).id, kind: 'test_run', source: 'test-runner', dataJson: JSON.stringify(passingTests), createdAt: new Date().toISOString() })
      expect(await depthOf(runId, workspace)).toBe('low')
    })

    test('a sensitive path still stops even when this run\'s own decision covers it', async () => {
      const { runId } = await projectRun()
      await go(runId, planned([{ jobs: login, question: authQ }, { jobs: login }]), person(runId))
      const second = (await measured(runId)).at(-1)!
      expect(second.simple).toBe(false)
      expect(second.reasons).toEqual([strings.plan.reasons.sensitive(strings.risk.areas.auth)])
      // It stopped for the person (who then built it); it did not start on its own.
      expect(await payloadOf(runId, 'node.plan_proposed', 'plan')).toHaveLength(1)
      expect((await payloadOf(runId, 'node.completed', 'plan')).at(-1)).not.toHaveProperty('autoStarted')
    })
  })

  test('the person\'s words go to the planner redacted and clipped, like a request for another plan', async () => {
    const { runId } = await projectRun()
    const secret = `API_KEY=supersecret123 ${'w'.repeat(900)}`
    const s = recordingStep(async event => {
      if (event !== QUESTION_ANSWERED) return false
      await answerQuestion((await openQuestion(runId))!.id, { option: 'other', text: secret }, { send: async () => undefined })
      return true
    })
    const provider = planner([{ jobs: footer, question }, { jobs: footer }])
    await go(runId, provider, s)
    const words = clip(redact(secret), 500)
    expect(provider.notes[1]).toBe(strings.providers.claude.answerNote(question.text, { option: 'own' }, words))
    expect(provider.notes[1]).not.toContain('supersecret123')
    expect(words.length).toBeLessThanOrEqual(500)
  })

  describe('the final check follows the mode', () => {
    const change = () => realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' })
    const passes = async (opts: { askMode?: AskMode; stopForMe?: boolean }) => {
      const { runId } = await projectRun(opts)
      await go(runId, withTests(), recordingStep(), change())
      return runId
    }

    test('a low-risk change passes on its own in "only what matters" and in "small changes"', async () => {
      for (const askMode of ['what_matters', 'small_changes'] as const) {
        const runId = await passes({ askMode })
        expect((await node(runId, 'human')).state).toBe('passed')
        expect(await payloadOf(runId, 'node.completed', 'human')).toMatchObject([{ summary: strings.risk.passedLow, autoApproved: true }])
      }
    })

    test('it stops in "everything", and with "stop for me"', async () => {
      for (const opts of [{ askMode: 'everything' as const }, { askMode: 'what_matters' as const, stopForMe: true }]) {
        const runId = await passes(opts)
        expect((await node(runId, 'human')).state).toBe('waiting_approval')
        expect(await payloadOf(runId, 'node.assessed', 'human')).toMatchObject([{ level: 'low' }])
      }
    })

    test('a run already in flight keeps its old setting', async () => {
      expect(modeOf({ autoApproveLowRisk: true } as Plan)).toEqual({ mode: 'small_changes', stopForMe: false })
      expect(modeOf({ autoApproveLowRisk: false } as Plan)).toEqual({ mode: 'everything', stopForMe: false })
      expect(modeOf({ autoApproveLowRisk: false, askMode: 'what_matters', stopForMe: true } as Plan)).toEqual({ mode: 'what_matters', stopForMe: true })
      // Its plan was read before the mode existed: the old switch decides, whatever the project says now.
      const { runId } = await projectRun({ askMode: 'everything' })
      const s = recordingStep()
      const run = s.run
      s.run = async (id, fn) => {
        const out = await run(id, fn)
        if (id !== 'plan') return out
        const old: Partial<Plan> = { ...(out as Plan), autoApproveLowRisk: true }
        delete old.askMode
        delete old.stopForMe
        return old as typeof out
      }
      await go(runId, withTests(), s, change())
      expect((await node(runId, 'human')).state).toBe('passed')
    })
  })

  describe('parked runs resume on the ids they parked on', () => {
    test('a plan waiting for the person waits on plan-decided-plan-0', async () => {
      const { runId } = await projectRun({ askMode: 'everything' })
      const s = recordingStep()
      await go(runId, planner([{ jobs: footer }]), s)
      expect(s.waits).toEqual(['plan-decided-plan-0'])
      expect(s.ids).toContain('node-plan')
    })

    test('a final check waiting for the person waits on approval-human', async () => {
      const { runId } = await projectRun({ askMode: 'everything' })
      const s = recordingStep()
      await go(runId, withTests(), s, realWorktree({ 'src/app/page.tsx': 'x\n' }))
      expect(s.waits).toEqual(['approval-human'])
      expect(s.ids).toEqual(expect.arrayContaining(['assess-human', 'node-human']))
    })
  })
})

// ---- after the change passes: kept, sent and opened on its own -----------------------------------------------------

describe('after a change passes in "only what matters"', () => {
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
  /** A project made the way the app makes one, with a GitHub-looking origin whose pushes land in a bare temporary folder. */
  async function shippingRun(askMode: AskMode, origin = true) {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ship-'))
    g(dir, 'init', '-q', '-b', 'main')
    g(dir, 'config', 'user.email', 'me@example.com')
    g(dir, 'config', 'user.name', 'me')
    writeFileSync(join(dir, 'README.md'), 'shop\n')
    g(dir, 'add', '.')
    g(dir, 'commit', '-q', '-m', 'mine')
    const bare = mkdtempSync(join(tmpdir(), 'factory-ship-origin-'))
    g(bare, 'init', '-q', '--bare', '-b', 'main')
    if (origin) {
      // Reads as GitHub when the app judges it; every push lands in the bare folder, and no network protocol is allowed.
      g(dir, 'remote', 'add', 'origin', 'https://github.com/ai-factory-test/never-real.git')
      g(dir, 'config', 'remote.origin.pushurl', bare)
      for (const p of ['https', 'http', 'ssh', 'git']) g(dir, 'config', `protocol.${p}.allow`, 'never')
    }
    const { workflowId } = await createProject({ path: dir, name: 'Shop', testCommand: 'npm test', checks: [], askMode })
    const { runId } = await createRun({ workflowId, request: 'add a footer' })
    await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
    return { runId, bare }
  }
  /** Writes one file in the run's own copy; the tests pass and the reviewer finds nothing. */
  function writes(file: string): AgentProvider {
    return {
      id: 'files', isDemo: false, needsWorkspace: true,
      async *execute(input) {
        if (input.blockKind === 'build') {
          mkdirSync(dirname(join(input.workdir!, file)), { recursive: true })
          writeFileSync(join(input.workdir!, file), 'x()\n')
        }
        if (input.blockKind === 'tests') yield { type: 'evidence', kind: 'test_run', data: passingTests }
        if (input.blockKind === 'review') {
          yield { type: 'done', summary: 'ok', source: 'provider', review: { verdict: 'ok', findings: [] } }
          return
        }
        yield { type: 'done', summary: 'ok', source: 'system' }
      },
    }
  }
  function fakeGh(): ((args: string[]) => Promise<string>) & { calls: string[][] } {
    const calls: string[][] = []
    let opened = false
    const gh = async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'create') return ((opened = true), '')
      if (args[1] === 'view') {
        if (!opened) throw new Error('no pull requests found')
        return JSON.stringify({ number: 9, url: 'https://github.com/me/shop/pull/9', state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], mergeCommit: null, mergedAt: null })
      }
      return ''
    }
    return Object.assign(gh, { calls })
  }
  /** Steps that remember their ids; the person approves when the run waits for them, if `yes`. */
  function steps(runId: string, yes: boolean): StepApi & { ids: string[]; seen: { human: string; kept: number }[] } {
    const ids: string[] = []
    const seen: { human: string; kept: number }[] = []
    return {
      ids, seen,
      run: async (id, fn) => (ids.push(id), JSON.parse(JSON.stringify((await fn()) ?? null))),
      waitForEvent: async () => {
        seen.push({ human: (await node(runId, 'human')).state, kept: (await payloadOf(runId, 'run.kept')).length })
        if (!yes) throw new Parked()
        await recordDecision(runId, 'approved', { actor: 'me', diffHash: null })
        return { data: { decision: 'approved' } }
      },
    }
  }
  async function go(runId: string, file: string, yes: boolean, connections = true) {
    const gh = fakeGh()
    const more: Partial<ExecutorDeps> = connections ? { autoShip: { gh, ask: async () => 'footer' } } : {}
    const root = mkdtempSync(join(tmpdir(), 'factory-ship-wts-'))
    const s = steps(runId, yes)
    try {
      await orchestrateRun(runId, s, { resolveProvider: () => writes(file), createWorktree: (repo, id, sp, req) => createRunWorktree(repo, id, root, sp, req), ...more })
    } catch (e) {
      if (!(e instanceof Parked)) throw e
    }
    return { ids: s.ids, seen: s.seen, gh }
  }
  const once = (ids: string[], id: string) => ids.filter(i => i === id).length
  const statusOf = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status

  test('a simple change reaches an open pull request without the person', async () => {
    const { runId, bare } = await shippingRun('what_matters')
    const { ids, gh } = await go(runId, 'src/ui/footer/Footer.tsx', false)
    expect(await statusOf(runId)).toBe('completed')
    expect((await node(runId, 'human')).state).toBe('passed')
    expect(await payloadOf(runId, 'run.pr_opened')).toMatchObject([{ number: 9, base: 'main' }])
    for (const id of ['auto-ship-check', 'auto-ship-keep', 'auto-ship-send', 'auto-ship-open']) expect(once(ids, id)).toBe(1)
    const branch = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.branch!
    expect(g(bare, 'branch', '--list', branch)).not.toBe('')
    expect(g(bare, 'branch', '--list', 'main')).toBe('')
    expect(gh.calls.some(c => c.includes('merge'))).toBe(false)
  })

  test('the person\'s yes also sends it', async () => {
    const { runId } = await shippingRun('what_matters')
    const { gh, seen } = await go(runId, 'src/lib/stripe.ts', true)
    // A sensitive change stopped for the person, with nothing kept, until their yes.
    expect(seen).toEqual([{ human: 'waiting_approval', kept: 0 }])
    expect(await statusOf(runId)).toBe('completed')
    expect(await payloadOf(runId, 'run.pr_opened')).toHaveLength(1)
    expect(gh.calls.some(c => c.includes('merge'))).toBe(false)
  })

  test('in "small changes" it passes on its own and nothing is kept or sent', async () => {
    const { runId } = await shippingRun('small_changes')
    const { ids, gh } = await go(runId, 'src/ui/footer/Footer.tsx', false)
    expect(await statusOf(runId)).toBe('completed')
    expect(await payloadOf(runId, 'node.completed', 'human')).toMatchObject([{ autoApproved: true }])
    expect(await payloadOf(runId, 'run.kept')).toEqual([])
    expect(ids).not.toContain('auto-ship-keep')
    expect(gh.calls).toEqual([])
  })

  test('without the app\'s connections and with no origin, it is kept, nothing is sent, and the run still completes', async () => {
    const { runId } = await shippingRun('what_matters', false)
    const { ids } = await go(runId, 'src/ui/footer/Footer.tsx', false, false)
    expect(await statusOf(runId)).toBe('completed')
    expect(await payloadOf(runId, 'run.kept')).toHaveLength(1)
    expect(await payloadOf(runId, 'run.pushed')).toEqual([])
    expect((await payloadOf(runId, 'run.auto_ship')).at(-1)).toMatchObject({ state: 'stopped', step: 'send', reason: 'no_connection' })
    expect(ids).not.toContain('auto-ship-open')
  })
})

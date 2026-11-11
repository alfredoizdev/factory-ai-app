import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { claims, evidence, nodeRuns, projects, runs, usageRecords, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { orchestrateRun, type ExecutorDeps, type StepApi } from '@/engine/inngest/execute-run'
import { recordDecision } from '@/engine/approvals'
import { cancelRun, createRun, publishVersion, saveDraft } from '@/engine/run'
import type { TestRun } from '@/engine/test-runner'
import type { AgentEvent, AgentProvider, BlockRoute } from '@/providers/types'
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
  db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId)).run()
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
      for (const ev of script[input.blockKind] ?? [{ type: 'done', summary: 'ok', source: 'system' }]) yield ev
    },
  }
}

async function drive(runId: string, provider: AgentProvider, createWorktree: ExecutorDeps['createWorktree'] = (_repo, id) => ({ path: `/wt/${id}`, branch: `factory/${id}`, baseCommit: 'abc' })) {
  try {
    await orchestrateRun(runId, step, { resolveProvider: () => provider, createWorktree })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
}

const node = (runId: string, blockId: string) => db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === blockId)!
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
  const row = db.select().from(runs).where(eq(runs.id, runId)).get()!
  expect([row.worktreePath, row.branch, row.baseCommit]).toEqual([`/wt/${runId}`, `factory/${runId}`, 'abc'])
  expect(provider.calls.every(c => c.workdir === `/wt/${runId}` && c.testCommand === 'npm test' && c.baseCommit === 'abc')).toBe(true)
})

test('a project with no repository fails the run before any agent starts, and says why', async () => {
  const runId = await newRun({ repoPath: null })
  const provider = filesProvider({})
  await drive(runId, provider)
  expect(provider.calls).toEqual([])
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()!.status).toBe('failed')
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
  expect(node(runId, 'review').state).toBe('skipped')
  expect(await payloadOf(runId, 'node.skipped', 'review')).toEqual([{ blockId: 'review', reason: 'Not yet.' }])
})

const testRun: TestRun = {
  command: 'npm test', exitCode: 1, signal: null, started: true, durationMs: 1234,
  counts: { passed: 3, failed: 1, total: 4 }, outputTail: 'FAIL src/a.test.ts', changedTestFiles: ['test/a.test.ts'],
}

test('evidence is stored whole in its own table, and the event carries numbers only', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  await drive(runId, filesProvider({ tests: [{ type: 'evidence', kind: 'test_run', data: testRun }, { type: 'done', summary: 'x', source: 'system' }] }))
  const rows = db.select().from(evidence).where(eq(evidence.runId, runId)).all()
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
  const build = node(runId, 'build')
  expect(db.select().from(usageRecords).where(eq(usageRecords.nodeRunId, build.id)).all().map(u => [u.tokens, u.costCents])).toEqual([[1200, null]])
  expect(db.select().from(claims).where(eq(claims.nodeRunId, build.id)).all().map(c => c.text)).toEqual(['Made it blue.'])
  expect(await payloadOf(runId, 'node.completed', 'build')).toEqual([{ blockId: 'build', summary: 'Made it blue.', summarySource: 'provider', attempt: 1, tokens: 1200 }])
  // A sentence the app composed is not a claim.
  expect(db.select().from(claims).where(eq(claims.nodeRunId, node(runId, 'input').id)).all()).toEqual([])
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
  expect(node(runId, 'tests').state).toBe('failed')
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
  expect(node(runId, 'tests').state).toBe('cancelled')
  expect(db.select().from(evidence).where(eq(evidence.runId, runId)).all()).toEqual([])
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
  expect(node(runId, 'human').state).toBe('passed')
  expect(await payloadOf(runId, 'node.assessed', 'human')).toMatchObject([{ level: 'low', filesCount: 1, linesChanged: 2 }])
  expect(await payloadOf(runId, 'node.completed', 'human')).toMatchObject([{ summary: strings.risk.passedLow, summarySource: 'system', autoApproved: true }])
  expect(node(runId, 'ship').state).not.toBe('queued')
})

test('with the switch off, the same change still stops for the person, with the measurement on record', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: false })
  await drive(runId, withTests(), realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }))
  expect(node(runId, 'human').state).toBe('waiting_approval')
  expect(await payloadOf(runId, 'node.assessed', 'human')).toMatchObject([{ level: 'low' }])
})

test('a change to something sensitive stops for the person even with the switch on, and says what', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  await drive(runId, withTests(), realWorktree({ 'src/lib/stripe.ts': 'charge()\n' }))
  expect(node(runId, 'human').state).toBe('waiting_approval')
  const [assessed] = await payloadOf(runId, 'node.assessed', 'human')
  expect(assessed!.level).toBe('high')
  expect(String(assessed!.reasons)).toContain('src/lib/stripe.ts')
})

test('with no tests run, nothing is low risk, even a one-line change', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: null, autoApproveLowRisk: true })
  await drive(runId, filesProvider({}), realWorktree({ 'src/app/page.tsx': 'one\nTWO\n' }))
  expect(node(runId, 'human').state).toBe('waiting_approval')
  expect(String((await payloadOf(runId, 'node.assessed', 'human'))[0]!.reasons)).toContain(strings.risk.noTests)
})

test('a run whose tests changed stops for the person', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: true })
  await drive(runId, withTests({ ...passingTests, changedTestFiles: ['test/a.test.ts'] }), realWorktree({ 'src/app/page.tsx': 'x\n' }))
  expect(node(runId, 'human').state).toBe('waiting_approval')
})

// ---- asking for changes: the return loop ----------------------------------------------------------------------

/** Hands out the person's decisions in order, recording each the way the app does before the event arrives. */
function decisionsStep(runId: string, queue: { decision: 'approved' | 'rejected' | 'changes'; note?: string }[]): StepApi {
  return {
    run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
    waitForEvent: async () => {
      const next = queue.shift()
      if (!next) throw new Parked()
      recordDecision(runId, next.decision, { actor: 'tester', reason: next.note ?? null, diffHash: null })
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
  expect(node(runId, 'human').state).toBe('waiting_approval')
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()!.status).toBe('waiting_approval')
})

test('after a round of changes, an approval finishes the run; the earlier "changes" is not read twice', async () => {
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const provider = withTests()
  await orchestrateRun(runId, decisionsStep(runId, [{ decision: 'changes', note: 'thicker' }, { decision: 'approved' }]), {
    resolveProvider: () => provider,
    createWorktree: realWorktree({ 'src/app/page.tsx': 'x\n' }),
  })
  expect(node(runId, 'human').state).toBe('passed')
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()!.status).toBe('completed')
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
  expect(node(runId, 'human').state).toBe('passed')
})

test('round 1 is handed the request\'s images; a round of changes gets only the images sent with it', async () => {
  const { saveAttachment, claimAttachments } = await import('@/engine/attachments')
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  const imgDir = mkdtempSync(join(tmpdir(), 'factory-img-'))
  const runId = await newRun({ repoPath: '/repo', testCommand: 'npm test' })
  const first = saveAttachment('mock.png', png, imgDir)
  claimAttachments([first.id], runId)
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
    const decision = db.select().from(approvals).where(eq(approvals.runId, runId)).all().at(-1)!
    const second = saveAttachment('better.png', png, imgDir)
    claimAttachments([second.id], runId, decision.id)
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
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  const version = db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)).get()!
  const graph = JSON.parse(version.graphJson) as { blocks: { kind: string; config: Record<string, unknown> }[] }
  graph.blocks.find(b => b.kind === 'build')!.config.model = 'opus'
  db.update(workflowVersions).set({ graphJson: JSON.stringify(graph) }).where(eq(workflowVersions.id, version.id)).run()
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
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  const version = db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)).get()!
  const graph = JSON.parse(version.graphJson) as { blocks: { kind: string; config: Record<string, unknown> }[] }
  Object.assign(graph.blocks.find(b => b.kind === 'build')!.config, { model: 'opus', modelFrontend: 'sonnet', modelBackend: 'opus' })
  db.update(workflowVersions).set({ graphJson: JSON.stringify(graph) }).where(eq(workflowVersions.id, version.id)).run()
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
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  const version = db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)).get()!
  const graph = JSON.parse(version.graphJson) as { blocks: { id: string; kind: string; label: string; enabled: boolean; config: Record<string, unknown>; position: { x: number; y: number } }[] }
  graph.blocks.push({ id: 'tests-1', kind: 'tests', label: 'Lint', enabled: true, config: { testCommand: '  npm run lint ' }, position: { x: 0, y: 1 } })
  db.update(workflowVersions).set({ graphJson: JSON.stringify(graph) }).where(eq(workflowVersions.id, version.id)).run()
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

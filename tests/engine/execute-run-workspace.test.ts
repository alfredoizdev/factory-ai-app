import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { claims, evidence, nodeRuns, projects, runs, usageRecords, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { orchestrateRun, type ExecutorDeps, type StepApi } from '@/engine/inngest/execute-run'
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

async function newRun(settings: { repoPath?: string | null; testCommand?: string | null } = {}): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: settings.repoPath ?? null, testCommand: settings.testCommand ?? null })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'do it' })
  db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId)).run()
  return runId
}

type Script = Partial<Record<string, AgentEvent[]>>
function filesProvider(script: Script, route?: (kind: string) => BlockRoute): AgentProvider & { calls: { kind: string; workdir?: string; testCommand?: string | null; baseCommit?: string }[] } {
  const calls: { kind: string; workdir?: string; testCommand?: string | null; baseCommit?: string }[] = []
  return {
    id: 'files',
    isDemo: false,
    needsWorkspace: true,
    route: route ? kind => route(kind) : undefined,
    calls,
    async *execute(input) {
      calls.push({ kind: input.blockKind, workdir: input.workdir, testCommand: input.testCommand, baseCommit: input.baseCommit })
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
  expect(made).toHaveBeenCalledWith('/repo', runId)
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

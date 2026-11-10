import { eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph, type Graph } from '@/domain/graph'
import { appendEvent, eventsSince } from '@/engine/events'
import { orchestrateRun, type ExecutorDeps, type StepApi } from '@/engine/inngest/execute-run'
import { failRunAfterError } from '@/engine/inngest/execute-run'
import { cancelRun, createRun, failUnstartedRun, publishVersion, saveDraft } from '@/engine/run'
import { createDemoProvider } from '@/providers/demo'
import type { AgentProvider } from '@/providers/types'

// These drive the orchestration directly with a stand-in for Inngest's step tools: no dev server is needed.

beforeAll(() => {
  migrateDb()
})

const now = () => new Date().toISOString()
const fast = createDemoProvider({ stepDelayMs: 1 })

class Parked extends Error {}

// Like Inngest, results pass through JSON, so a step returning something unserialisable fails here too.
function fakeStep(decision?: { decision: string } | null): StepApi {
  return {
    run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
    waitForEvent: async () => {
      if (decision) return { data: decision }
      if (decision === null) return null // the wait expired with no decision
      throw new Parked()
    },
  }
}

async function drive(runId: string, provider: AgentProvider, decision?: { decision: string } | null) {
  const deps: ExecutorDeps = { resolveProvider: () => provider }
  try {
    await orchestrateRun(runId, fakeStep(decision), deps)
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
}

async function newRun(request: string, tweak?: (g: Graph) => void): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({
    id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now(),
  })
  const graph = defaultGraph()
  tweak?.(graph)
  await saveDraft(workflowId, graph)
  await publishVersion(workflowId)
  return (await createRun({ workflowId, request })).runId
}

async function runToCompletion(request: string, provider: AgentProvider = fast) {
  const runId = await newRun(request)
  await drive(runId, provider)
  return { runId }
}

async function getNodeRun(runId: string, blockId: string) {
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))
  return rows.find(r => r.blockId === blockId)!
}
const runStatus = async (runId: string) => (await db.query.runs.findFirst({ where: eq(runs.id, runId) }))!.status
const types = async (runId: string) => (await eventsSince(runId, 0)).map(e => e.type)

const silentProvider: AgentProvider = {
  id: 'silent', isDemo: false,
  async *execute() { await new Promise(() => {}) },
}

test('a demo run walks every enabled block and ends waiting on the human', async () => {
  const { runId } = await runToCompletion('add a spinner')
  const evts = await eventsSince(runId, 0)
  expect(evts.at(-1)!.type).toBe('node.waiting_approval')
  const completed = evts.filter(e => e.type === 'node.completed').map(e => (e.payload as { blockId: string }).blockId)
  expect(completed).toEqual(['input', 'plan', 'build', 'tests', 'review', 'approve'])
  expect(evts.map(e => e.type)).not.toContain('run.completed')
  expect(await runStatus(runId)).toBe('waiting_approval')
  expect((await getNodeRun(runId, 'human')).state).toBe('waiting_approval')
  // The block after the human never started: the run is waiting, not finished.
  expect(await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).then(r => r.some(n => n.blockId === 'ship'))).toBe(false)
})

test('events carry strictly increasing sequence numbers and every node event names its block', async () => {
  const { runId } = await runToCompletion('add a spinner')
  const evts = await eventsSince(runId, 0)
  expect(evts.map(e => e.sequence)).toEqual(evts.map((_, i) => i + 1))
  for (const e of evts.filter(e => e.type.startsWith('node.'))) {
    expect((e.payload as { blockId?: string }).blockId).toEqual(expect.any(String))
  }
})

test('a failing node is recorded as failed and never reported as success', async () => {
  const { runId } = await runToCompletion('FAIL please')
  const evts = await eventsSince(runId, 0)
  expect(evts.some(e => e.type === 'node.failed')).toBe(true)
  expect(evts.some(e => e.type === 'run.completed')).toBe(false)
  expect(evts.at(-1)!.type).toBe('run.failed')
  expect(await runStatus(runId)).toBe('failed')
  expect((await getNodeRun(runId, 'input')).failureCause).toMatch(/.+/)
})

test('retries are bounded and then the node stays failed', async () => {
  const { runId } = await runToCompletion('FAIL please')
  const failedNode = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.state === 'failed')!
  expect(failedNode.attempt).toBe(2)
  const evts = await eventsSince(runId, 0)
  expect(evts.filter(e => e.type === 'node.failed')).toHaveLength(1)
  expect(evts.filter(e => e.type === 'node.step' && (e.payload as { retry?: boolean }).retry)).toHaveLength(1)
  // Nothing after the failed node ran.
  expect(await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).toHaveLength(1)
})

test('a failure in a later node fails the run even though earlier nodes passed', async () => {
  const failOnBuild: AgentProvider = {
    ...fast,
    execute: (input, c) => fast.execute(input.blockKind === 'build' ? { ...input, request: 'FAIL' } : input, c),
  }
  const { runId } = await runToCompletion('add a spinner', failOnBuild)
  expect((await getNodeRun(runId, 'plan')).state).toBe('passed')
  const build = await getNodeRun(runId, 'build')
  expect(build.state).toBe('failed')
  expect(build.attempt).toBe(2)
  expect(await runStatus(runId)).toBe('failed')
})

test('cancelling stops the in-flight provider and every later node, and persists the state', async () => {
  const runId = await newRun('slow')
  let aborted = false
  const slow: AgentProvider = {
    id: 'slow', isDemo: false,
    async *execute(_i, { signal }) {
      yield { type: 'step', text: 'working' }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
    },
  }
  const driven = drive(runId, slow)
  for (let i = 0; i < 100 && !(await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).some(n => n.state === 'running'); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  await cancelRun(runId)
  await driven
  const states = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).map(n => n.state)
  expect(states.filter(s => s === 'running')).toHaveLength(0)
  expect(states).toEqual(['cancelled'])
  expect(aborted).toBe(true)
  expect(await runStatus(runId)).toBe('cancelled')
  const t = await types(runId)
  expect(t).toContain('node.cancelled')
  expect(t.at(-1)).toBe('run.cancelled')
  expect(t).not.toContain('run.completed')
  expect(t.filter(x => x === 'node.started')).toHaveLength(1)
})

test('a run cancelled before it starts runs nothing', async () => {
  const runId = await newRun('add a spinner')
  await cancelRun(runId)
  await drive(runId, fast)
  expect(await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).toHaveLength(0)
  expect(await types(runId)).toEqual(['run.created', 'run.cancelled'])
})

test('a disabled block is skipped with a reason, not silently dropped', async () => {
  const runId = await newRun('add a spinner', g => { g.blocks.find(b => b.kind === 'tests')!.enabled = false })
  await drive(runId, fast)
  const evts = await eventsSince(runId, 0)
  const skip = evts.find(e => e.type === 'node.skipped')
  expect(skip!.payload).toMatchObject({ blockId: 'tests', reason: expect.stringMatching(/.+/) })
  expect((await getNodeRun(runId, 'tests')).state).toBe('skipped')
  expect(evts.filter(e => e.type === 'node.started' && (e.payload as { blockId: string }).blockId === 'tests')).toHaveLength(0)
})

// Review Focus 4
test('a provider that emits nothing times out instead of hanging', async () => {
  const runId = await newRun('add a spinner', g => { g.blocks.find(b => b.kind === 'input')!.config = { timeoutMs: 50 } })
  const started = Date.now()
  await drive(runId, silentProvider)
  expect(Date.now() - started).toBeLessThan(2000)
  expect(await runStatus(runId)).toBe('failed')
  const node = await getNodeRun(runId, 'input')
  expect(node.failureCause).toBe('timeout')
  expect(node.state).toBe('failed')
})

test('a human approval resumes the run and only then does it complete', async () => {
  const runId = await newRun('add a spinner')
  await drive(runId, fast, { decision: 'approved' })
  const t = await types(runId)
  expect(t.at(-1)).toBe('run.completed')
  expect(await runStatus(runId)).toBe('completed')
  expect((await getNodeRun(runId, 'ship')).state).toBe('passed')
})

test('a rejection fails the run', async () => {
  const runId = await newRun('add a spinner')
  await drive(runId, fast, { decision: 'rejected' })
  expect((await getNodeRun(runId, 'human')).failureCause).toBe('rejected')
  expect(await runStatus(runId)).toBe('failed')
})

test('a run with no run.created event still executes', async () => {
  const runId = await newRun('add a spinner')
  await db.run(sql`delete from events where run_id = ${runId}`)
  await drive(runId, fast)
  expect((await types(runId)).at(-1)).toBe('node.waiting_approval')
})

test('an expired human wait is not a verdict: the run stays waiting, neither completed nor failed', async () => {
  const runId = await newRun('add a spinner')
  await drive(runId, fast, null)
  const t = await types(runId)
  expect(t).not.toContain('run.completed')
  expect(t).not.toContain('run.failed')
  expect(t.at(-1)).toBe('node.waiting_approval')
  expect(await runStatus(runId)).toBe('waiting_approval')
  expect((await getNodeRun(runId, 'human')).state).toBe('waiting_approval')
})

test('every node row has a node.queued event before node.started', async () => {
  const { runId } = await runToCompletion('add a spinner')
  const evts = await eventsSince(runId, 0)
  for (const n of await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))) {
    const mine = evts.filter(e => e.nodeRunId === n.id).map(e => e.type)
    expect(mine[0]).toBe('node.queued')
    expect(mine[1]).toBe('node.started')
  }
})

test('a retry step names the attempt about to start and why the previous one failed', async () => {
  const { runId } = await runToCompletion('FAIL please')
  const retry = (await eventsSince(runId, 0)).find(e => e.type === 'node.step' && (e.payload as { retry?: boolean }).retry)!
  expect(retry.payload).toMatchObject({ attempt: 2, previousCause: 'provider_error', previousMessage: expect.stringMatching(/.+/) })
})

test('a provider that throws keeps the exception detail on the failure', async () => {
  const throwing: AgentProvider = {
    id: 't', isDemo: false,
    async *execute() { throw new Error('disk exploded') },
  }
  const { runId } = await runToCompletion('add a spinner', throwing)
  const failed = (await eventsSince(runId, 0)).find(e => e.type === 'node.failed')!
  expect(failed.payload).toMatchObject({ cause: 'provider_crashed', detail: 'disk exploded' })
  expect(await runStatus(runId)).toBe('failed')
})

test('an unresolvable provider strands no node row and the failure handler fails the run', async () => {
  const runId = await newRun('add a spinner')
  const deps: ExecutorDeps = { resolveProvider: () => { throw new Error('no such provider') } }
  await expect(orchestrateRun(runId, fakeStep(), deps)).rejects.toThrow('no such provider')
  expect(await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).toHaveLength(0)
  failRunAfterError(runId)
  expect(await runStatus(runId)).toBe('failed')
  expect((await types(runId)).at(-1)).toBe('run.failed')
})

test('the failure handler fails a node left running and then the run, once', async () => {
  const runId = await newRun('add a spinner')
  const run = (await db.query.runs.findFirst({ where: eq(runs.id, runId) }))!
  db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId)).run()
  const nodeRunId = ulid()
  db.insert(nodeRuns).values({ id: nodeRunId, projectId: run.projectId, runId, blockId: 'build', state: 'running', attempt: 1 }).run()
  failRunAfterError(runId)
  failRunAfterError(runId) // idempotent
  expect((await getNodeRun(runId, 'build')).state).toBe('failed')
  expect((await getNodeRun(runId, 'build')).failureCause).toBe('internal_error')
  expect(await runStatus(runId)).toBe('failed')
  expect((await types(runId)).filter(t => t === 'run.failed')).toHaveLength(1)
})

test('the failure handler leaves a cancelled run alone', async () => {
  const runId = await newRun('x')
  await cancelRun(runId)
  failRunAfterError(runId)
  expect(await runStatus(runId)).toBe('cancelled')
})

// The carried obligation: row and event are one write.
describe('atomic run writes', () => {
  afterEach(() => { db.run(sql`drop trigger if exists boom`) })
  const failInsert = (type: string) =>
    db.run(sql.raw(`create trigger boom before insert on events when new.type = '${type}' begin select raise(abort, 'boom'); end`))

  test('createRun leaves no run behind when run.created cannot be written', async () => {
    const projectId = ulid()
    const workflowId = ulid()
    await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
    await db.insert(workflows).values({
      id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now(),
    })
    await publishVersion(workflowId)
    failInsert('run.created')
    await expect(createRun({ workflowId, request: 'x' })).rejects.toThrow(/boom/)
    expect(await db.select().from(runs).where(eq(runs.workflowId, workflowId))).toHaveLength(0)
  })

  test('cancelRun does not mark the run cancelled when run.cancelled cannot be written, and can be retried', async () => {
    const runId = await newRun('x')
    failInsert('run.cancelled')
    await expect(cancelRun(runId)).rejects.toThrow(/boom/)
    expect(await runStatus(runId)).toBe('queued')
    db.run(sql`drop trigger boom`)
    await cancelRun(runId)
    expect(await runStatus(runId)).toBe('cancelled')
    expect((await types(runId)).at(-1)).toBe('run.cancelled')
  })

  test('appendEvent with a transaction handle rolls back with the caller', async () => {
    const runId = await newRun('x')
    expect(() =>
      db.transaction(tx => {
        tx.update(runs).set({ status: 'running' }).where(eq(runs.id, runId)).run()
        void appendEvent({ runId, type: 'run.started' }, tx)
        throw new Error('crash')
      }),
    ).toThrow('crash')
    expect(await runStatus(runId)).toBe('queued')
    expect(await types(runId)).toEqual(['run.created'])
  })

  test('failUnstartedRun ends a queued run with an event', async () => {
    const runId = await newRun('x')
    await failUnstartedRun(runId)
    expect(await runStatus(runId)).toBe('failed')
    expect((await types(runId)).at(-1)).toBe('run.failed')
  })
})

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { orchestrateRun, type StepApi } from '@/engine/inngest/execute-run'
import { cleanJobs, currentPlan, decidePlan, parsePlan, PlanError, workList, type Job } from '@/engine/plan'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import type { AgentExecutionInput, AgentProvider } from '@/providers/types'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

test('a plan is read from the planner\'s last JSON object, cleaned and bounded', () => {
  const text = 'I read the page.\n{"jobs":[{"title":" Add a ring ","done":["5px thick",""," pink and blue "]},{"title":""}]}'
  expect(parsePlan(text)).toEqual([{ title: 'Add a ring', done: ['5px thick', 'pink and blue'] }])
  expect(parsePlan('no plan here')).toBeNull()
  expect(parsePlan('{"jobs":[]}')).toBeNull()
  expect(cleanJobs(Array.from({ length: 20 }, (_, i) => ({ title: `j${i}`, done: [] })))).toHaveLength(8)
  expect(workList([{ title: 'A', done: ['x'] }, { title: 'B', done: [] }])).toBe('1. A\n   - Done when: x\n2. B')
})

class Parked extends Error {}

async function newRun(): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: '/repo' })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'add a ring around the crest' })
  db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId)).run()
  return runId
}

/** The planner proposes these plans in turn; every other block just passes. Records what each block was given. */
function planningProvider(plans: Job[][]): AgentProvider & { calls: AgentExecutionInput[] } {
  const calls: AgentExecutionInput[] = []
  return {
    id: 'files',
    isDemo: false,
    needsWorkspace: true,
    calls,
    async *execute(input) {
      calls.push(input)
      if (input.blockKind === 'plan') {
        const jobs = plans.shift()!
        yield { type: 'done', summary: strings.plan.proposed(jobs.length), source: 'provider', plan: jobs }
        return
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
}

/** Hands out the person's words on the plan in order, recorded the way the app records them before telling the run. */
function wordsStep(runId: string, words: ({ action: 'build'; jobs: Job[] } | { action: 'replan'; note: string })[]): StepApi {
  return {
    run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
    waitForEvent: async () => {
      const next = words.shift()
      if (!next) throw new Parked()
      decidePlan(runId, next)
      return { data: {} }
    },
  }
}

async function drive(runId: string, provider: AgentProvider, step: StepApi) {
  try {
    await orchestrateRun(runId, step, { resolveProvider: () => provider, createWorktree: (_r, id) => ({ path: `/wt/${id}`, branch: `factory/${id}`, baseCommit: 'abc' }) })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
}

const node = (runId: string, blockId: string) => db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === blockId)!

test('the run stops at the plan; nothing is built until the person says so', async () => {
  const runId = await newRun()
  const provider = planningProvider([[{ title: 'Add a ring', done: ['5px'] }]])
  await drive(runId, provider, wordsStep(runId, []))
  expect(node(runId, 'plan').state).toBe('waiting_approval')
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()!.status).toBe('waiting_approval')
  expect(provider.calls.map(c => c.blockKind)).toEqual(['input', 'plan'])
  expect(provider.calls[1]!.model).toBe('sonnet')
  expect(currentPlan(runId)).toEqual({ jobs: [{ title: 'Add a ring', done: ['5px'] }], by: 'planner' })
})

test('asking for a new plan runs the planner again with the note; building gives the builder the edited jobs', async () => {
  const runId = await newRun()
  const provider = planningProvider([[{ title: 'A', done: [] }, { title: 'B', done: [] }], [{ title: 'One job', done: ['ring is 5px'] }]])
  const edited: Job[] = [{ title: 'One job, edited', done: ['ring is 5px', 'crest unchanged'] }]
  await drive(runId, provider, wordsStep(runId, [{ action: 'replan', note: 'do it in one job' }, { action: 'build', jobs: edited }]))
  const plans = provider.calls.filter(c => c.blockKind === 'plan')
  expect(plans).toHaveLength(2)
  expect(plans[1]!.revisionNote).toBe('do it in one job')
  expect(node(runId, 'plan').state).toBe('passed')
  const build = provider.calls.find(c => c.blockKind === 'build')!
  expect(build.jobs).toEqual(edited)
  expect(currentPlan(runId)).toEqual({ jobs: edited, by: 'person' })
  const done = (await eventsSince(runId, 0)).filter(e => e.type === 'node.completed' && (e.payload as { blockId: string }).blockId === 'plan')
  expect((done.at(-1)!.payload as { summary: string }).summary).toBe(strings.plan.confirmed(1))
})

test('a word on the plan is refused when no plan waits, and a plan needs a job', async () => {
  const runId = await newRun()
  expect(() => decidePlan(runId, { action: 'build', jobs: [{ title: 'x', done: [] }] })).toThrow(PlanError)
  const provider = planningProvider([[{ title: 'A', done: [] }]])
  await drive(runId, provider, wordsStep(runId, []))
  expect(() => decidePlan(runId, { action: 'build', jobs: [{ title: '  ', done: [] }] })).toThrow(strings.plan.needAJob)
  expect(() => decidePlan(runId, { action: 'replan', note: ' ' })).toThrow(strings.plan.needANote)
})

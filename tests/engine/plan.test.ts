import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { orchestrateRun, type StepApi } from '@/engine/inngest/execute-run'
import { cleanJobs, currentPlan, decidePlan, parsePlan, readPlannerAnswer, PlanError, workList, type Job } from '@/engine/plan'
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

test('a plan is read even when the planner quoted code with braces before it', () => {
  const text = 'The page renders `<p>{sum(2, 2)}</p>` today.\n```json\n{"jobs":[{"title":"Add the sum","done":["shows 4"]}]}\n```'
  expect(parsePlan(text)).toEqual([{ title: 'Add the sum', done: ['shows 4'] }])
})

describe('the planner\'s answer: paths and one question', () => {
  const form = '{"jobs":[{"title":"Add footer","done":["shows year"],"paths":["src/ui/Footer.tsx","src/ui/footer/"]}]}'
  const q = (extra: string) => `{"jobs":[{"title":"a","done":[]}],"question":${extra}}`
  const opts = '[{"id":"a","label":"Email","means":"as today"},{"id":"b","label":"Username","means":"new field"}]'

  test('paths are read as written; a string is a list of one; none stays none', () => {
    expect(readPlannerAnswer(`I looked.\n${form}`)).toEqual({ jobs: [{ title: 'Add footer', done: ['shows year'], paths: ['src/ui/Footer.tsx', 'src/ui/footer/'] }], question: null })
    expect(readPlannerAnswer('{"jobs":[{"title":"a","done":[],"paths":"./src/a.ts"}]}')!.jobs[0]!.paths).toEqual(['src/a.ts'])
    expect(readPlannerAnswer('{"jobs":[{"title":"a","done":[],"paths":[]}]}')!.jobs[0]!.paths).toEqual([])
    expect(readPlannerAnswer('{"jobs":[{"title":"a","done":[],"paths":7}]}')!.jobs[0]!.paths).toBeUndefined()
    expect(readPlannerAnswer('{"jobs":[{"title":"a","done":[]}]}')!.jobs[0]!.paths).toBeUndefined()
  })

  test('paths are neither redacted nor lower-cased, and are bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/F${i}.ts`)
    const jobs = cleanJobs([{ title: 'a', done: [], paths: [' ./src/Ui/Footer.TSX ', ...many, 'x'.repeat(400)] }])!
    expect(jobs[0]!.paths).toHaveLength(20)
    expect(jobs[0]!.paths![0]).toBe('src/Ui/Footer.TSX')
    expect(cleanJobs([{ title: 'a', done: [], paths: ['x'.repeat(400)] }])![0]!.paths![0]).toHaveLength(300)
  })

  test('a question with text, why, paths and two options is read', () => {
    const a = readPlannerAnswer(q(`{"text":"Which way?","why":"It changes sign-in","paths":["src/auth/"],"options":${opts}}`))!
    expect(a.question).toEqual({ text: 'Which way?', why: 'It changes sign-in', paths: ['src/auth/'], options: [{ id: 'a', label: 'Email', means: 'as today' }, { id: 'b', label: 'Username', means: 'new field' }] })
  })

  test('a question with one option or no text is unreadable; leave and other are dropped before counting', () => {
    expect(readPlannerAnswer(q('{"text":"Which?","options":[{"id":"a","label":"A","means":"m"}]}'))!.question).toBe('unreadable')
    expect(readPlannerAnswer(q(`{"why":"w","options":${opts}}`))!.question).toBe('unreadable')
    expect(readPlannerAnswer(q('{"text":"Which?","options":[{"id":"a","label":"A","means":"m"},{"id":"leave","label":"L","means":"m"},{"id":"other","label":"O","means":"m"}]}'))!.question).toBe('unreadable')
    expect(readPlannerAnswer(q('"just words"'))!.question).toBe('unreadable')
    expect(readPlannerAnswer(q('{"text":"Which?","options":[{"id":"a","label":"A","means":"m"},{"id":"a","label":"B","means":"m"},{"id":"Bad Id","label":"C","means":"m"}]}'))!.question).toBe('unreadable')
  })

  test('at most four options, and the question is read from the same object as the jobs', () => {
    const five = Array.from({ length: 5 }, (_, i) => `{"id":"o${i}","label":"L${i}","means":"m"}`).join(',')
    const a = readPlannerAnswer(q(`{"text":"Which?","options":[${five}]}`))!
    expect((a.question as { options: unknown[] }).options).toHaveLength(4)
    const earlier = `{"jobs":[{"title":"old","done":[]}],"question":{"text":"Which?","options":[${five}]}}\nChanged my mind: {"jobs":[{"title":"new","done":[]}]}`
    expect(readPlannerAnswer(earlier)).toEqual({ jobs: [{ title: 'new', done: [] }], question: null })
  })

  test('code with braces before the object still parses; today\'s form gives the same jobs', () => {
    expect(readPlannerAnswer(`It renders {sum(2,2)} today.\n${form}`)!.jobs[0]!.title).toBe('Add footer')
    expect(parsePlan('{"jobs":[{"title":"a","done":["x"]}]}')).toEqual([{ title: 'a', done: ['x'] }])
    expect(readPlannerAnswer('no plan')).toBeNull()
  })
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
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
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
      await decidePlan(runId, next)
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

const node = async (runId: string, blockId: string) => (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === blockId)!

test('the run stops at the plan; nothing is built until the person says so', async () => {
  const runId = await newRun()
  const provider = planningProvider([[{ title: 'Add a ring', done: ['5px'] }]])
  await drive(runId, provider, wordsStep(runId, []))
  expect((await node(runId, 'plan')).state).toBe('waiting_approval')
  expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('waiting_approval')
  expect(provider.calls.map(c => c.blockKind)).toEqual(['input', 'plan'])
  expect(provider.calls[1]!.model).toBe('sonnet')
  expect((await currentPlan(runId))).toEqual({ jobs: [{ title: 'Add a ring', done: ['5px'] }], by: 'planner' })
})

test('asking for a new plan runs the planner again with the note; building gives the builder the edited jobs', async () => {
  const runId = await newRun()
  const provider = planningProvider([[{ title: 'A', done: [] }, { title: 'B', done: [] }], [{ title: 'One job', done: ['ring is 5px'] }]])
  const edited: Job[] = [{ title: 'One job, edited', done: ['ring is 5px', 'crest unchanged'] }]
  await drive(runId, provider, wordsStep(runId, [{ action: 'replan', note: 'do it in one job' }, { action: 'build', jobs: edited }]))
  const plans = provider.calls.filter(c => c.blockKind === 'plan')
  expect(plans).toHaveLength(2)
  expect(plans[1]!.revisionNote).toBe('do it in one job')
  expect((await node(runId, 'plan')).state).toBe('passed')
  const build = provider.calls.find(c => c.blockKind === 'build')!
  expect(build.jobs).toEqual(edited)
  expect((await currentPlan(runId))).toEqual({ jobs: edited, by: 'person' })
  const done = (await eventsSince(runId, 0)).filter(e => e.type === 'node.completed' && (e.payload as { blockId: string }).blockId === 'plan')
  expect((done.at(-1)!.payload as { summary: string }).summary).toBe(strings.plan.confirmed(1))
})

test('the reviewers are given the plan the person checked, with how to tell each job is done', async () => {
  const runId = await newRun()
  const provider = planningProvider([[{ title: 'A', done: [] }]])
  const edited: Job[] = [{ title: 'Add the ring', done: ['ring is 5px'] }]
  await drive(runId, provider, wordsStep(runId, [{ action: 'build', jobs: edited }]))
  const readers = provider.calls.filter(c => c.blockKind === 'review' && !c.role)
  expect(readers.length).toBeGreaterThan(0)
  for (const r of readers) expect(r.jobs).toEqual(edited)
})

test('the person\'s plan records the paths of its jobs, and none for jobs without', async () => {
  const runId = await newRun()
  await drive(runId, planningProvider([[{ title: 'A', done: [] }]]), wordsStep(runId, []))
  await decidePlan(runId, { action: 'build', jobs: [{ title: 'x', done: [], paths: ['a.ts'] }, { title: 'y', done: [] }] })
  const planned = (await eventsSince(runId, 0)).filter(e => e.type === 'node.planned').at(-1)!.payload as { jobs: Job[] }
  expect(planned.jobs[0]!.paths).toEqual(['a.ts'])
  expect('paths' in planned.jobs[1]!).toBe(false)
  expect((await currentPlan(runId))!.jobs[0]!.paths).toEqual(['a.ts'])
})

test('a word on the plan is refused when no plan waits, and a plan needs a job', async () => {
  const runId = await newRun()
  await expect(decidePlan(runId, { action: 'build', jobs: [{ title: 'x', done: [] }] })).rejects.toThrow(PlanError)
  const provider = planningProvider([[{ title: 'A', done: [] }]])
  await drive(runId, provider, wordsStep(runId, []))
  await expect(decidePlan(runId, { action: 'build', jobs: [{ title: '  ', done: [] }] })).rejects.toThrow(strings.plan.needAJob)
  await expect(decidePlan(runId, { action: 'replan', note: ' ' })).rejects.toThrow(strings.plan.needANote)
})

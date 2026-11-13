import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { blockDetails } from '@/engine/block-details'
import { appendEvent } from '@/engine/events'
import { createRun, publishVersion, saveDraft } from '@/engine/run'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

async function newRun(): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: '/repo' })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'add a ring' })
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  return runId
}

test('the plan block reports each job with its paths, and what the app made of the plan', async () => {
  const runId = await newRun()
  const plan = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'plan')!
  await appendEvent({ runId, nodeRunId: plan.id, type: 'node.planned', payload: { blockId: 'plan', by: 'planner', jobs: [{ title: 'Add footer', done: ['shows year'], paths: ['src/ui/Footer.tsx'] }, { title: 'Say thanks', done: [] }] } })
  await appendEvent({ runId, nodeRunId: plan.id, type: 'node.plan_measured', payload: { blockId: 'plan', simple: false, reasons: ['It expects to change files that deal with sign-in.', 'Too many.'], entries: ['src/auth/login.ts'], mode: 'what_matters', stopForMe: false } })
  const d = (await blockDetails(runId, 'plan'))!
  expect(d.jobs).toEqual([{ title: 'Add footer', done: ['shows year'], paths: ['src/ui/Footer.tsx'] }, { title: 'Say thanks', done: [] }])
  expect(d.planMeasure).toEqual({ simple: false, reasons: ['It expects to change files that deal with sign-in.', 'Too many.'], entries: ['src/auth/login.ts'] })
})

test('a block with no measured plan has no planMeasure', async () => {
  const runId = await newRun()
  expect((await blockDetails(runId, 'build'))!.planMeasure).toBeUndefined()
})

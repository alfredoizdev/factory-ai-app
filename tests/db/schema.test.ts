import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { seedDemoProject } from '@/db/seed'
import { projects, workflows, workflowVersions, runs, nodeRuns, usageRecords } from '@/db/schema'

beforeAll(() => {
  migrateDb()
})

const now = () => new Date().toISOString()

async function createNodeRunChain() {
  const projectId = ulid()
  const workflowId = ulid()
  const versionId = ulid()
  const runId = ulid()
  const nodeRunId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({
    id: workflowId, projectId, name: 'w', draftJson: '{}', createdAt: now(), updatedAt: now(),
  })
  await db.insert(workflowVersions).values({
    id: versionId, projectId, workflowId, graphJson: '{}', hash: 'h', createdAt: now(),
  })
  await db.insert(runs).values({
    id: runId, projectId, workflowId, versionId, status: 'queued', request: 'r', providerId: 'fake', createdAt: now(),
  })
  await db.insert(nodeRuns).values({ id: nodeRunId, projectId, runId, blockId: 'build', state: 'queued' })
  return { projectId, runId, nodeRunId }
}

async function insertUsage(chain: { projectId: string; nodeRunId: string }) {
  const [row] = await db
    .insert(usageRecords)
    .values({ id: ulid(), projectId: chain.projectId, nodeRunId: chain.nodeRunId, createdAt: now() })
    .returning()
  return row!
}

test('seed creates one project with one workflow and a demo graph', async () => {
  const { projectId, workflowId } = await seedDemoProject()
  const wf = await db.query.workflows.findFirst({ where: eq(workflows.id, workflowId) })
  expect(workflowId).toBe('demo')
  expect(wf?.projectId).toBe(projectId)
  expect(JSON.parse(wf!.draftJson).blocks.length).toBeGreaterThanOrEqual(6)
})

test('seed is idempotent', async () => {
  const first = await seedDemoProject()
  const second = await seedDemoProject()
  expect(second).toEqual(first)
  expect(await db.select().from(projects).where(eq(projects.id, first.projectId))).toHaveLength(1)
  expect(await db.select().from(workflows).where(eq(workflows.id, 'demo'))).toHaveLength(1)
})

test('usage tokens and cost are nullable, not defaulted to zero', async () => {
  const row = await insertUsage(await createNodeRunChain())
  expect(row.tokens).toBeNull()
  expect(row.costCents).toBeNull()
})

test('foreign keys are enforced: a child row with no parent is rejected', async () => {
  const { projectId } = await createNodeRunChain()
  await expect(
    db.insert(usageRecords).values({ id: ulid(), projectId, nodeRunId: 'missing', createdAt: now() }),
  ).rejects.toThrow(/FOREIGN KEY/)
})

test('deleting a run cascades to its node runs and usage records', async () => {
  const chain = await createNodeRunChain()
  const usage = await insertUsage(chain)
  await db.delete(runs).where(eq(runs.id, chain.runId))
  expect(await db.select().from(nodeRuns).where(eq(nodeRuns.id, chain.nodeRunId))).toHaveLength(0)
  expect(await db.select().from(usageRecords).where(eq(usageRecords.id, usage.id))).toHaveLength(0)
})

test('deleting a workflow that has a run is rejected and history survives', async () => {
  const chain = await createNodeRunChain()
  const usage = await insertUsage(chain)
  const run = (await db.select().from(runs).where(eq(runs.id, chain.runId)))[0]!
  await expect(db.delete(workflows).where(eq(workflows.id, run.workflowId))).rejects.toThrow(/FOREIGN KEY/)
  expect(await db.select().from(runs).where(eq(runs.id, chain.runId))).toHaveLength(1)
  expect(await db.select().from(nodeRuns).where(eq(nodeRuns.id, chain.nodeRunId))).toHaveLength(1)
  expect(await db.select().from(usageRecords).where(eq(usageRecords.id, usage.id))).toHaveLength(1)
})

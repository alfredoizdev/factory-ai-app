import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { seedDemoProject } from '@/db/seed'
import { projects, workflows, usageRecords } from '@/db/schema'

beforeAll(() => {
  migrateDb()
})

async function insertUsage(input: { nodeRunId: string }) {
  const [row] = await db
    .insert(usageRecords)
    .values({
      id: ulid(),
      projectId: 'p1',
      nodeRunId: input.nodeRunId,
      createdAt: new Date().toISOString(),
    })
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
  expect(await db.select().from(projects)).toHaveLength(1)
  expect(await db.select().from(workflows)).toHaveLength(1)
})

test('usage tokens and cost are nullable, not defaulted to zero', async () => {
  const row = await insertUsage({ nodeRunId: 'n1' })
  expect(row.tokens).toBeNull()
  expect(row.costCents).toBeNull()
})

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { appendEventSync } from '@/engine/events'
import { promptsOf } from '@/engine/prompts'
import { createRun, publishVersion, saveDraft } from '@/engine/run'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

test('what was asked on a task, in order and by whom, with a reopened round counted once', async () => {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'add a ring' })
  const nodes = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))
  const node = async (blockId: string) => nodes.find(n => n.blockId === blockId)!.id
  await db.transaction(async tx => {
    await appendEventSync({ runId, nodeRunId: (await node('plan')), type: 'node.plan_decided', payload: { blockId: 'plan', action: 'replan', note: 'one job only' } }, tx)
    // Asking for a new plan reopens the plan too: said once, as a new plan.
    await appendEventSync({ runId, nodeRunId: (await node('plan')), type: 'node.reopened', payload: { blockId: 'plan', round: 2, note: 'one job only', by: 'person' } }, tx)
    await appendEventSync({ runId, nodeRunId: (await node('build')), type: 'node.reopened', payload: { blockId: 'build', round: 2, note: 'thicker', by: 'person' } }, tx)
    await appendEventSync({ runId, nodeRunId: (await node('tests')), type: 'node.reopened', payload: { blockId: 'tests', round: 2, note: 'thicker', by: 'person' } }, tx)
    await appendEventSync({ runId, nodeRunId: (await node('build')), type: 'node.reopened', payload: { blockId: 'build', round: 3, note: 'fix the null check', by: 'reviewer' } }, tx)
  })
  expect((await promptsOf(runId)).map(p => [p.kind, p.text])).toEqual([
    ['request', 'add a ring'],
    ['replan', 'one job only'],
    ['changes', 'thicker'],
    ['reviewer', 'fix the null check'],
  ])
})

test('a follow-up carries what was asked on the tasks it continues from, marked as earlier', async () => {
  const { runs } = await import('@/db/schema')
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const first = await createRun({ workflowId, request: 'add a ring' })
  const second = await createRun({ workflowId, request: 'make it 5px' })
  await db.update(runs).set({ parentRunId: first.runId }).where(eq(runs.id, second.runId))
  expect((await promptsOf(second.runId)).map(p => [p.kind, p.text, p.earlier ?? false])).toEqual([
    ['request', 'add a ring', true],
    ['followUp', 'make it 5px', false],
  ])
})

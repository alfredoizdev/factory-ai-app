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
  db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() }).run()
  db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() }).run()
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'add a ring' })
  const nodes = db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all()
  const node = (blockId: string) => nodes.find(n => n.blockId === blockId)!.id
  db.transaction(tx => {
    appendEventSync({ runId, nodeRunId: node('plan'), type: 'node.plan_decided', payload: { blockId: 'plan', action: 'replan', note: 'one job only' } }, tx)
    // Asking for a new plan reopens the plan too: said once, as a new plan.
    appendEventSync({ runId, nodeRunId: node('plan'), type: 'node.reopened', payload: { blockId: 'plan', round: 2, note: 'one job only', by: 'person' } }, tx)
    appendEventSync({ runId, nodeRunId: node('build'), type: 'node.reopened', payload: { blockId: 'build', round: 2, note: 'thicker', by: 'person' } }, tx)
    appendEventSync({ runId, nodeRunId: node('tests'), type: 'node.reopened', payload: { blockId: 'tests', round: 2, note: 'thicker', by: 'person' } }, tx)
    appendEventSync({ runId, nodeRunId: node('build'), type: 'node.reopened', payload: { blockId: 'build', round: 3, note: 'fix the null check', by: 'reviewer' } }, tx)
  })
  expect(promptsOf(runId).map(p => [p.kind, p.text])).toEqual([
    ['request', 'add a ring'],
    ['replan', 'one job only'],
    ['changes', 'thicker'],
    ['reviewer', 'fix the null check'],
  ])
})

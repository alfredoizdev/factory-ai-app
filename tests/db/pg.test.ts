import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { nodeRuns, projects, questions, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { createRun, publishVersion, saveDraft } from '@/engine/run'

test('a row written can be read back, and a broken foreign key is refused', async () => {
  const at = new Date().toISOString()
  await db.insert(projects).values({ id: 'p1', projectId: 'p1', name: 'One', createdAt: at })
  const [row] = await db.select().from(projects).where(eq(projects.id, 'p1'))
  expect(row).toMatchObject({ id: 'p1', name: 'One', autoApproveLowRisk: false, askMode: null, baseStatus: 'none' })
  await expect(db.insert(workflows).values({ id: 'w', projectId: 'missing', name: 'w', draftJson: '{}', createdAt: at, updatedAt: at })).rejects.toThrow()
})

test('a freshly migrated question reads paths: null', async () => {
  const at = new Date().toISOString()
  await db.insert(projects).values({ id: 'p2', projectId: 'p2', name: 'Two', createdAt: at })
  await db.insert(workflows).values({ id: 'w2', projectId: 'p2', name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: at, updatedAt: at })
  await saveDraft('w2', defaultGraph())
  await publishVersion('w2')
  const { runId } = await createRun({ workflowId: 'w2', request: 'x' })
  const node = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))[0]!
  await db.insert(questions).values({ id: 'q1', projectId: 'p2', runId, nodeRunId: node.id, kind: 'finding', text: 'Fix it?', why: 'w', optionsJson: '[]', touchesJson: '[]', state: 'open', createdAt: at })
  const [row] = await db.select().from(questions).where(eq(questions.id, 'q1'))
  expect(row).toMatchObject({ paths: null })
})

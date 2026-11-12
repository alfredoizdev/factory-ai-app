import { ulid } from 'ulid'
import { db } from '@/db/client'
import { projects, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { appendEvent, eventsSince } from '@/engine/events'
import { createRun, publishVersion, saveDraft } from '@/engine/run'

test('two writers appending to one run at once leave sequences gap-free, increasing and unique', async () => {
  const now = new Date().toISOString()
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now, updatedAt: now })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'r' })
  const start = (await eventsSince(runId, 0)).length
  const batch = () => Promise.all(Array.from({ length: 25 }, () => appendEvent({ runId, type: 'run.started' })))
  await Promise.all([batch(), batch()])
  const sequences = (await eventsSince(runId, 0)).map(e => e.sequence)
  expect(sequences).toEqual(Array.from({ length: start + 50 }, (_, i) => i + 1))
})

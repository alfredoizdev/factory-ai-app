import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { moveBlock } from '@/ui/canvas/editing'
import { saveDraft, publishVersion } from '@/engine/run'

beforeAll(() => migrateDb())

test('moving a block saves the position but republishing returns the same version', async () => {
  const now = new Date().toISOString()
  const projectId = ulid()
  const wf = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now })
  await db.insert(workflows).values({
    id: wf, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now, updatedAt: now,
  })
  const first = await publishVersion(wf)
  await saveDraft(wf, moveBlock(defaultGraph(), 'build', { x: 40, y: 0 }))
  const again = await publishVersion(wf)
  expect(again.hash).toBe(first.hash)
  expect(again.versionId).toBe(first.versionId)
})

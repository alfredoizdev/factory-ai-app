import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects, workflows } from '@/db/schema'

test('a row written can be read back, and a broken foreign key is refused', async () => {
  const at = new Date().toISOString()
  await db.insert(projects).values({ id: 'p1', projectId: 'p1', name: 'One', createdAt: at })
  const [row] = await db.select().from(projects).where(eq(projects.id, 'p1'))
  expect(row).toMatchObject({ id: 'p1', name: 'One', autoApproveLowRisk: false, baseStatus: 'none' })
  await expect(db.insert(workflows).values({ id: 'w', projectId: 'missing', name: 'w', draftJson: '{}', createdAt: at, updatedAt: at })).rejects.toThrow()
})

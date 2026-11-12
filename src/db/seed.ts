import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { defaultGraph } from '@/domain/graph'
import { strings } from '@/ui/strings'
import { db, migrateDb } from './client'
import { projects, workflows } from './schema'

export const DEMO_WORKFLOW_ID = 'demo'

export async function seedDemoProject(): Promise<{ projectId: string; workflowId: string }> {
  const now = new Date().toISOString()
  // Immediate transaction: the existence check and the insert are one atomic step,
  // so concurrent seed processes serialize instead of colliding on the 'demo' key.
  return db.transaction(
    async tx => {
      const existing = (await tx.select().from(workflows).where(eq(workflows.id, DEMO_WORKFLOW_ID)))[0]
      if (existing) return { projectId: existing.projectId, workflowId: existing.id }

      const projectId = ulid()
      await tx.insert(projects).values({ id: projectId, projectId, name: strings.demo.projectName, createdAt: now })
      await tx.insert(workflows)
        .values({
          id: DEMO_WORKFLOW_ID,
          projectId,
          name: strings.demo.workflowName,
          draftJson: JSON.stringify(defaultGraph()),
          createdAt: now,
          updatedAt: now,
        })
        
      return { projectId, workflowId: DEMO_WORKFLOW_ID }
    },
  )
}

// `npm run seed`
if (process.argv[1]?.endsWith('seed.ts')) {
  await migrateDb()
  seedDemoProject().then(r => console.log(r))
}

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { defaultGraph } from '@/domain/graph'
import { strings } from '@/ui/strings'
import { db, migrateDb } from './client'
import { projects, workflows } from './schema'

export const DEMO_WORKFLOW_ID = 'demo'

export async function seedDemoProject(): Promise<{ projectId: string; workflowId: string }> {
  const existing = await db.query.workflows.findFirst({ where: eq(workflows.id, DEMO_WORKFLOW_ID) })
  if (existing) return { projectId: existing.projectId, workflowId: existing.id }

  const now = new Date().toISOString()
  const projectId = ulid()
  db.transaction(tx => {
    tx.insert(projects).values({ id: projectId, projectId, name: strings.demo.projectName, createdAt: now }).run()
    tx.insert(workflows)
      .values({
        id: DEMO_WORKFLOW_ID,
        projectId,
        name: strings.demo.workflowName,
        draftJson: JSON.stringify(defaultGraph()),
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  return { projectId, workflowId: DEMO_WORKFLOW_ID }
}

// `npm run seed`
if (process.argv[1]?.endsWith('seed.ts')) {
  migrateDb()
  seedDemoProject().then(r => console.log(r))
}

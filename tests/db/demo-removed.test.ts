import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, migrateDb } from '@/db/client'
import { workflows } from '@/db/schema'
import { DEMO_WORKFLOW_ID, removeUnusedDemoProject, seedDemoProject } from '@/db/seed'
import { createProject, listProjects } from '@/engine/projects'
import { createRun, publishVersion } from '@/engine/run'

// The example project older versions opened on: gone once it has no use, kept when someone ran a task in it.

beforeAll(() => migrateDb())
const demoExists = async () => (await db.select().from(workflows).where(eq(workflows.id, DEMO_WORKFLOW_ID))).length === 1

test('an example project nobody used is removed, and adding a real project removes it too', async () => {
  await seedDemoProject()
  expect(await removeUnusedDemoProject()).toBe(true)
  expect(await demoExists()).toBe(false)
  expect(await removeUnusedDemoProject()).toBe(false)

  await seedDemoProject()
  const dir = mkdtempSync(join(tmpdir(), 'factory-demo-'))
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'a')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first')
    const { workflowId } = await createProject({ path: dir, name: 'real', testCommand: null, checks: [] })
    expect(await demoExists()).toBe(false)
    expect((await listProjects()).map(p => p.workflowId)).toContain(workflowId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an example project with a task in it is someone\'s history and stays', async () => {
  await seedDemoProject()
  await publishVersion(DEMO_WORKFLOW_ID)
  await createRun({ workflowId: DEMO_WORKFLOW_ID, request: 'try it' })
  expect(await removeUnusedDemoProject()).toBe(false)
  expect(await demoExists()).toBe(true)
})

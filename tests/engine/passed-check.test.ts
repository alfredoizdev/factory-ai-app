import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { approvals, nodeRuns, projects, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { appendEvent } from '@/engine/events'
import { humanCheckPassedBy } from '@/engine/passed-check'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

async function aRun() {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'x' })
  const node = async (blockId: string) => (await db.select().from(nodeRuns).where(and(eq(nodeRuns.runId, runId), eq(nodeRuns.blockId, blockId))))[0]!
  return { projectId, runId, node }
}

/** The way the executor records a gate the app passed on its own (passLowRiskGate). */
async function appPasses(runId: string, nodeRunId: string, blockId: string) {
  await db.update(nodeRuns).set({ state: 'passed', summary: strings.risk.passedLow }).where(eq(nodeRuns.id, nodeRunId))
  await appendEvent({ runId, nodeRunId, type: 'node.completed', payload: { blockId, summary: strings.risk.passedLow, summarySource: 'system', autoApproved: true } })
}

test('a human check the app passed on its own is passed by the app', async () => {
  const { runId, node } = await aRun()
  await appPasses(runId, (await node('human')).id, 'human')
  expect(await humanCheckPassedBy(runId)).toBe('app')
})

test('a person approval is passed by the person', async () => {
  const { projectId, runId, node } = await aRun()
  await db.insert(approvals).values({ id: ulid(), projectId, runId, nodeRunId: (await node('human')).id, decision: 'approved', actor: 'me', diffHash: 'h', createdAt: now(), consumedAt: now() })
  expect(await humanCheckPassedBy(runId)).toBe('person')
})

test('nothing decided gives null', async () => {
  const { runId } = await aRun()
  expect(await humanCheckPassedBy(runId)).toBeNull()
})

test('autoApproved on a block that is not a human check does not count', async () => {
  const { runId, node } = await aRun()
  await appPasses(runId, (await node('tests')).id, 'tests')
  expect(await humanCheckPassedBy(runId)).toBeNull()
})

test('a run that does not exist gives null', async () => {
  expect(await humanCheckPassedBy('nope')).toBeNull()
})

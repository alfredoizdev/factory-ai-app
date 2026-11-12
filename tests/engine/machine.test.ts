import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { approvals, machines, nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { appendEvent } from '@/engine/events'
import { elsewhere, projectHere, runPlace, setLocal, thisMachine } from '@/engine/machine'
import { deliverPending } from '@/engine/relay'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { strings } from '@/ui/strings'

const now = () => new Date().toISOString()

async function aRun(): Promise<{ projectId: string; runId: string }> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'r' })
  return { projectId, runId }
}

test('a run started here is here; one on another computer says where it is', async () => {
  const { runId } = await aRun()
  expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]!.machineId).toBe(thisMachine().id)
  expect(await runPlace(runId)).toMatchObject({ here: true })
  expect(await elsewhere(runId)).toBeNull()
  await db.insert(machines).values({ id: 'other', name: 'Studio iMac', createdAt: now() })
  await db.update(runs).set({ machineId: 'other' }).where(eq(runs.id, runId))
  expect(await runPlace(runId)).toEqual({ here: false, machineId: 'other', machine: 'Studio iMac' })
  expect(await elsewhere(runId)).toBe(strings.machine.elsewhere('Studio iMac'))
})

test('each computer has its own folder for a project', async () => {
  const { projectId } = await aRun()
  await setLocal(projectId, { repoPath: '/Users/me/site' })
  expect((await projectHere(projectId))!.repoPath).toBe('/Users/me/site')
  // The shared row is untouched: another computer does not see this computer's folder.
  expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]!.repoPath).toBeNull()
})

test('a decision recorded elsewhere is delivered once, by the run\'s own computer only', async () => {
  const { projectId, runId } = await aRun()
  const human = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'human')!
  const decide = (id: string, run: string, node: string) =>
    db.insert(approvals).values({ id, projectId, runId: run, nodeRunId: node, decision: 'approved', actor: 'someone', createdAt: now() })
  await decide('a1', runId, human.id)
  // A plan word too, recorded on another computer.
  const plan = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'plan')!
  await appendEvent({ runId, nodeRunId: plan.id, type: 'node.plan_decided', payload: { blockId: 'plan', action: 'build' } })
  // A decision on a run of a third computer is not ours to deliver.
  const { runId: theirs } = await aRun()
  await db.update(runs).set({ machineId: 'third' }).where(eq(runs.id, theirs))
  const theirHuman = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, theirs))).find(n => n.blockId === 'human')!
  await decide('a2', theirs, theirHuman.id)

  const sent: { name: string; data: Record<string, unknown> }[] = []
  const send = async (e: { name: string; data: Record<string, unknown> }) => void sent.push(e)
  expect(await deliverPending(send, 'approval', 'plan')).toBe(2)
  expect(sent).toEqual([
    { name: 'approval', data: { runId, decision: 'approved' } },
    { name: 'plan', data: { runId } },
  ])
  expect(await deliverPending(send, 'approval', 'plan')).toBe(0)
})

test('a decision whose telling fails is told again on the next pass', async () => {
  const { projectId, runId } = await aRun()
  const human = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'human')!
  await db.insert(approvals).values({ id: ulid(), projectId, runId, nodeRunId: human.id, decision: 'changes', actor: 'x', reason: 'thicker', createdAt: now() })
  await expect(deliverPending(async () => { throw new Error('inngest is down') }, 'approval', 'plan')).resolves.toBe(0)
  const sent: unknown[] = []
  expect(await deliverPending(async e => void sent.push(e), 'approval', 'plan')).toBe(1)
})

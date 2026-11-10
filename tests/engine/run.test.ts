import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, workflows, workflowVersions, runs } from '@/db/schema'
import { defaultGraph, type Graph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { saveDraft, publishVersion, createRun, cancelRun, NothingPublishedError } from '@/engine/run'

beforeAll(() => {
  migrateDb()
})

const now = () => new Date().toISOString()

async function newWorkflow(): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({
    id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now(),
  })
  return workflowId
}

function addReviewer(graph: Graph): Graph {
  return {
    blocks: [
      ...graph.blocks,
      { id: 'review-2', kind: 'review', label: 'Second review', enabled: true, config: {}, position: { x: 0, y: 200 } },
    ],
  }
}

async function getRun(runId: string) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) })
  return run!
}

async function graphOf(versionId: string): Promise<Graph> {
  const v = await db.query.workflowVersions.findFirst({ where: eq(workflowVersions.id, versionId) })
  return JSON.parse(v!.graphJson) as Graph
}

let wf: string
beforeEach(async () => {
  wf = await newWorkflow()
})

test('saving a draft returns the validation issues without refusing the save', async () => {
  const issues = await saveDraft(wf, { blocks: defaultGraph().blocks.filter(b => b.kind !== 'build') })
  expect(issues.map(i => i.code)).toContain('missing_required_stage')
  const row = await db.query.workflows.findFirst({ where: eq(workflows.id, wf) })
  expect(JSON.parse(row!.draftJson).blocks).toHaveLength(7)
})

test('publishing an invalid graph is refused', async () => {
  await saveDraft(wf, { blocks: defaultGraph().blocks.filter(b => b.kind !== 'build') })
  await expect(publishVersion(wf)).rejects.toThrow(/missing_required_stage/)
  expect(await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf))).toHaveLength(0)
})

test('the version hash changes only when the graph changes', async () => {
  const a = await publishVersion(wf)
  const b = await publishVersion(wf)
  expect(b.hash).toBe(a.hash)
  expect(b.versionId).toBe(a.versionId)

  await saveDraft(wf, addReviewer(defaultGraph()))
  const c = await publishVersion(wf)
  expect(c.hash).not.toBe(a.hash)
  expect(c.versionId).not.toBe(a.versionId)
})

test('moving a block does not mint a new version', async () => {
  const a = await publishVersion(wf)
  const moved = defaultGraph()
  moved.blocks = moved.blocks.map(b => ({ ...b, position: { x: b.position.x + 500, y: 77 } }))
  await saveDraft(wf, moved)
  // The draft really changed, so an identical hash comes from position exclusion, not from nothing happening.
  const row = await db.query.workflows.findFirst({ where: eq(workflows.id, wf) })
  expect(row!.draftJson).toBe(JSON.stringify(moved))
  expect(row!.draftJson).not.toBe(JSON.stringify(defaultGraph()))
  const b = await publishVersion(wf)
  expect(b.hash).toBe(a.hash)
  expect(await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf))).toHaveLength(1)
})

test('the hash does not depend on key order', async () => {
  const a = await publishVersion(wf)
  const reordered = defaultGraph()
  reordered.blocks = reordered.blocks.map(b => ({
    position: b.position, config: b.config, enabled: b.enabled, label: b.label, kind: b.kind, id: b.id,
  }))
  const wf2 = await newWorkflow()
  await saveDraft(wf2, reordered)
  expect((await publishVersion(wf2)).hash).toBe(a.hash)
})

// Review Focus 3
test('editing the draft does not alter a run already created', async () => {
  await publishVersion(wf)
  const { runId, versionId } = await createRun({ workflowId: wf, request: 'x' })
  await saveDraft(wf, addReviewer(defaultGraph()))
  await publishVersion(wf)
  const run = await getRun(runId)
  expect(run.versionId).toBe(versionId)
  expect((await graphOf(run.versionId)).blocks).toHaveLength(8)
})

test('a run binds to the published version, not to an unpublished draft', async () => {
  const published = await publishVersion(wf)
  await saveDraft(wf, addReviewer(defaultGraph()))
  const { versionId } = await createRun({ workflowId: wf, request: 'x' })
  expect(versionId).toBe(published.versionId)
  expect((await graphOf(versionId)).blocks).toHaveLength(8)
})

test('a new run binds to the latest published version', async () => {
  await publishVersion(wf)
  await saveDraft(wf, addReviewer(defaultGraph()))
  const second = await publishVersion(wf)
  const { versionId } = await createRun({ workflowId: wf, request: 'x' })
  expect(versionId).toBe(second.versionId)
})

test('creating a run with nothing published is refused', async () => {
  await expect(createRun({ workflowId: wf, request: 'x' })).rejects.toBeInstanceOf(NothingPublishedError)
})

test('creating a run emits run.created as sequence 1', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  const [first, ...rest] = await eventsSince(runId, 0)
  expect(first!.type).toBe('run.created')
  expect(first!.sequence).toBe(1)
  expect(rest).toHaveLength(0)
  expect((await getRun(runId)).status).toBe('queued')
})

test('cancelling marks the run cancelled and records it once', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  await cancelRun(runId)
  await cancelRun(runId)
  const run = await getRun(runId)
  expect(run.status).toBe('cancelled')
  expect(run.finishedAt).not.toBeNull()
  const types = (await eventsSince(runId, 0)).map(e => e.type)
  expect(types).toEqual(['run.created', 'run.cancelled'])
})

test('cancelling a finished run leaves it untouched', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  await db.update(runs).set({ status: 'completed', finishedAt: now() }).where(eq(runs.id, runId))
  await cancelRun(runId)
  expect((await getRun(runId)).status).toBe('completed')
  expect((await eventsSince(runId, 0)).map(e => e.type)).toEqual(['run.created'])
})

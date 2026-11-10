import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, workflows, workflowVersions, runs } from '@/db/schema'
import { appendEvent, eventsSince } from '@/engine/events'

beforeAll(() => {
  migrateDb()
})

const now = () => new Date().toISOString()

async function newRun(): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  const versionId = ulid()
  const runId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({
    id: workflowId, projectId, name: 'w', draftJson: '{}', createdAt: now(), updatedAt: now(),
  })
  await db.insert(workflowVersions).values({
    id: versionId, projectId, workflowId, graphJson: '{}', hash: 'h', createdAt: now(),
  })
  await db.insert(runs).values({
    id: runId, projectId, workflowId, versionId, status: 'queued', request: 'r', providerId: 'fake', createdAt: now(),
  })
  return runId
}

test('sequence is contiguous per run under concurrent appends', async () => {
  const runId = await newRun()
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    appendEvent({ runId, type: 'node.step', payload: { blockId: 'build', i } })))
  const seqs = (await eventsSince(runId, 0)).map(e => e.sequence)
  expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
})

test('two runs keep independent sequences and never leak', async () => {
  const [a, b] = [await newRun(), await newRun()]
  await appendEvent({ runId: a, type: 'run.started' })
  await appendEvent({ runId: b, type: 'run.started' })
  await appendEvent({ runId: a, type: 'node.started', payload: { blockId: 'build' } })
  expect((await eventsSince(a, 0)).map(e => e.sequence)).toEqual([1, 2])
  expect((await eventsSince(b, 0)).map(e => e.sequence)).toEqual([1])
  expect((await eventsSince(b, 0)).every(e => e.runId === b)).toBe(true)
})

test('eventsSince returns only what the client has not seen', async () => {
  const runId = await newRun()
  for (let i = 0; i < 5; i++) await appendEvent({ runId, type: 'node.step', payload: { blockId: 'build' } })
  const after = await eventsSince(runId, 3)
  expect(after.map(e => e.sequence)).toEqual([4, 5])
})

test('payload round-trips and blockId is preserved on node events', async () => {
  const runId = await newRun()
  const row = await appendEvent({ runId, type: 'node.completed', payload: { blockId: 'build', summary: 'ok' } })
  expect(row.payload).toEqual({ blockId: 'build', summary: 'ok' })
  expect((await eventsSince(runId, 0))[0]).toEqual(row)
})

test('run events default to an empty payload; node events without blockId are rejected at the type level', async () => {
  const runId = await newRun()
  const row = await appendEvent({ runId, type: 'run.created' })
  expect(row.payload).toEqual({})
  // @ts-expect-error node.* events must carry blockId
  await appendEvent({ runId, type: 'node.started' })
})

test('an event for a missing run is rejected and allocates nothing', async () => {
  await expect(appendEvent({ runId: 'missing', type: 'run.created' })).rejects.toThrow(/FOREIGN KEY/)
})

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, workflows, workflowVersions, runs } from '@/db/schema'
import { defaultGraph, type Graph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { saveDraft, publishVersion, createRun, cancelRun, NothingPublishedError, DEMO_PROVIDER_ID } from '@/engine/run'

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

test('a created run is persisted as a demo run', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  expect((await getRun(runId)).providerId).toBe(DEMO_PROVIDER_ID)
  expect(DEMO_PROVIDER_ID).toBe('demo')
})

test('creating a run emits run.created as sequence 1', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  const [first, ...rest] = await eventsSince(runId, 0)
  expect(first!.type).toBe('run.created')
  expect(first!.sequence).toBe(1)
  // Nothing else but the queued node of each block (the design's section 7, step 2): no run.* event, no start.
  expect(rest.map(e => e.type)).toEqual(Array(8).fill('node.queued'))
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
  expect(types.filter(t => t.startsWith('run.'))).toEqual(['run.created', 'run.cancelled'])
  expect(types.filter(t => t === 'node.cancelled')).toHaveLength(8) // each queued node is cancelled once, not twice
})

test('cancelling a finished run leaves it untouched', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  await db.update(runs).set({ status: 'completed', finishedAt: now() }).where(eq(runs.id, runId))
  await cancelRun(runId)
  expect((await getRun(runId)).status).toBe('completed')
  expect((await eventsSince(runId, 0)).map(e => e.type)).not.toContain('node.cancelled')
  expect((await eventsSince(runId, 0)).map(e => e.type).filter(t => t.startsWith('run.'))).toEqual(['run.created'])
})

test('creating a run creates one queued node run per block, with a node.queued event each', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))
  expect(rows.map(r => r.blockId).sort()).toEqual(defaultGraph().blocks.map(b => b.id).sort())
  expect(rows.every(r => r.state === 'queued' && r.startedAt === null)).toBe(true)
  const queued = (await eventsSince(runId, 0)).filter(e => e.type === 'node.queued')
  expect(queued.map(e => e.nodeRunId).sort()).toEqual(rows.map(r => r.id).sort())
})

test('a node run is unique per block per run', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))
  expect(() =>
    db.insert(nodeRuns).values({ id: ulid(), projectId: row!.projectId, runId, blockId: row!.blockId, state: 'queued', attempt: 1 }).run(),
  ).toThrow(/UNIQUE/)
})

test('cancelling a run that never started cancels the blocks it never reached', async () => {
  await publishVersion(wf)
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  await cancelRun(runId)
  const states = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).map(r => r.state)
  expect(states).toEqual(Array(8).fill('cancelled'))
})

test('a save from a page that loaded an older draft is refused, so it cannot undo a newer edit', async () => {
  const { saveDraftVersioned, DraftConflictError } = await import('@/engine/run')
  const id = await newWorkflow()
  const loaded = db.select().from(workflows).where(eq(workflows.id, id)).get()!.updatedAt
  // Tab A saves first; its next save builds on what it got back.
  const a1 = await saveDraftVersioned(id, defaultGraph(), loaded)
  const a2 = await saveDraftVersioned(id, defaultGraph(), a1.updatedAt)
  expect(a2.updatedAt > a1.updatedAt).toBe(true)
  // Tab B, opened before, still holds the first version: refused, and the draft is A's.
  const stale = { blocks: defaultGraph().blocks.slice(0, 3) }
  await expect(saveDraftVersioned(id, stale, loaded)).rejects.toBeInstanceOf(DraftConflictError)
  expect(JSON.parse(db.select().from(workflows).where(eq(workflows.id, id)).get()!.draftJson).blocks).toHaveLength(defaultGraph().blocks.length)
  // Without a base the save is unconditional, as before.
  await saveDraft(id, stale)
})

describe('where a fresh task starts', () => {
  async function withRepo() {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
    const repo = mkdtempSync(join(tmpdir(), 'factory-start-'))
    g(repo, 'init', '-q', '-b', 'main')
    g(repo, 'config', 'user.email', 'me@example.com')
    g(repo, 'config', 'user.name', 'me')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'a')
    const main = g(repo, 'rev-parse', 'HEAD')
    // The folder is left on a feature branch with its own commit, as after looking at an earlier change.
    g(repo, 'checkout', '-q', '-b', 'ai/feature')
    writeFileSync(join(repo, 'a.txt'), 'b\n')
    g(repo, 'commit', '-qam', 'b')
    const feature = g(repo, 'rev-parse', 'HEAD')
    const workflowId = await newWorkflow()
    const wf = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()!
    db.update(projects).set({ repoPath: repo }).where(eq(projects.id, wf.projectId)).run()
    await saveDraft(workflowId, defaultGraph())
    await publishVersion(workflowId)
    return { workflowId, main, feature }
  }

  test('from the main branch, whatever branch the folder is on', async () => {
    const { workflowId, main } = await withRepo()
    const { runId } = await createRun({ workflowId, request: 'x', providerId: 'claude' })
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()!.baseCommit).toBe(main)
  })

  test('from another branch when the person picks it', async () => {
    const { workflowId, feature } = await withRepo()
    const { runId } = await createRun({ workflowId, request: 'x', providerId: 'claude', startFrom: 'ai/feature' })
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()!.baseCommit).toBe(feature)
  })

  test('a branch that does not exist is refused before anything is written', async () => {
    const { StartBranchError } = await import('@/engine/run')
    const { workflowId } = await withRepo()
    const before = db.select().from(runs).all().length
    await expect(createRun({ workflowId, request: 'x', providerId: 'claude', startFrom: 'nope' })).rejects.toBeInstanceOf(StartBranchError)
    expect(db.select().from(runs).all().length).toBe(before)
  })
})

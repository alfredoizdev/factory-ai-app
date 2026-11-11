import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { approvals, nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { changeUnderReview, decideGate, GateError, NO_CHANGE } from '@/engine/approvals'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { POST } from '@/app/api/runs/[runId]/decision/route'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

/** A run parked at its human check; with `worktree`, it has a real worktree holding one change. */
async function parkedRun(worktree = false): Promise<{ runId: string; dir?: string }> {
  const projectId = ulid()
  const workflowId = ulid()
  db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() }).run()
  db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() }).run()
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'r' })
  db.update(runs).set({ status: 'waiting_approval' }).where(eq(runs.id, runId)).run()
  const human = db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === 'human')!
  db.update(nodeRuns).set({ state: 'waiting_approval' }).where(eq(nodeRuns.id, human.id)).run()
  if (!worktree) return { runId }
  const dir = mkdtempSync(join(tmpdir(), 'factory-gate-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  db.update(runs).set({ worktreePath: dir, baseCommit: git('rev-parse', 'HEAD') }).where(eq(runs.id, runId)).run()
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  return { runId, dir }
}

const sent: unknown[] = []
const deps = { send: async (d: unknown) => void sent.push(d), actor: () => 'tester, at this computer' }
const rows = (runId: string) => db.select().from(approvals).where(eq(approvals.runId, runId)).all()

test('a decision on the change that was shown is recorded with who, then delivered', async () => {
  const { runId } = await parkedRun(true)
  const shown = changeUnderReview(runId)!
  expect(shown.files).toEqual([{ path: 'a.txt', added: 1, removed: 1 }])
  await decideGate(runId, { decision: 'approved', reason: 'looks right', diffHash: shown.hash }, deps)
  expect(rows(runId)).toMatchObject([{ decision: 'approved', actor: 'tester, at this computer', reason: 'looks right', diffHash: shown.hash }])
  expect(sent.at(-1)).toEqual({ runId, decision: 'approved' })
})

test('if the change moved after it was shown, the decision is refused and nothing is recorded', async () => {
  const { runId, dir } = await parkedRun(true)
  const shown = changeUnderReview(runId)!
  writeFileSync(join(dir!, 'a.txt'), 'three\n') // a late edit
  await expect(decideGate(runId, { decision: 'approved', diffHash: shown.hash }, deps)).rejects.toThrow(strings.gate.changedSinceSeen)
  expect(rows(runId)).toEqual([])
})

test('a new file the change adds is part of what is shown and of what the approval is bound to', async () => {
  const { runId, dir } = await parkedRun(true)
  const before = changeUnderReview(runId)!.hash
  writeFileSync(join(dir!, 'new.ts'), 'export const x = 1\n')
  const after = changeUnderReview(runId)!
  expect(after.hash).not.toBe(before)
  expect(after.files.map(f => f.path)).toContain('new.ts')
})

test('a run that changed no files is decided on "no change"', async () => {
  const { runId } = await parkedRun(false)
  expect(changeUnderReview(runId)).toBeNull()
  await decideGate(runId, { decision: 'rejected', diffHash: NO_CHANGE }, deps)
  expect(rows(runId)[0]!.decision).toBe('rejected')
})

test('a run that is not waiting cannot be decided', async () => {
  const { runId } = await parkedRun(false)
  db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId)).run()
  await expect(decideGate(runId, { decision: 'approved', diffHash: NO_CHANGE }, deps)).rejects.toBeInstanceOf(GateError)
})

test('a decision that cannot be delivered leaves no record claiming it was made', async () => {
  const { runId } = await parkedRun(false)
  await expect(decideGate(runId, { decision: 'approved', diffHash: NO_CHANGE }, { send: async () => { throw new Error('down') } })).rejects.toThrow(strings.gate.notDelivered)
  expect(rows(runId)).toEqual([])
})

const post = (runId: string, headers: Record<string, string>) =>
  POST(
    new Request(`http://localhost:4100/api/runs/${runId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:4100', ...headers },
      body: JSON.stringify({ decision: 'approved', diffHash: NO_CHANGE }),
    }),
    { params: Promise.resolve({ runId }) },
  )

test("the decision route refuses anything but the app's own page: no browser headers, another site, the network", async () => {
  const { runId } = await parkedRun(false)
  expect((await post(runId, {})).status).toBe(403) // curl, a script, a local agent
  expect((await post(runId, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  expect((await post(runId, { host: '10.0.0.118:4100', 'sec-fetch-site': 'same-origin' })).status).toBe(403)
  expect(rows(runId)).toEqual([])
})

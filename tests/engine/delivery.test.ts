import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { approvals, nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { deliverToProject, DeliveryError, deliveryState } from '@/engine/delivery'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { createRunWorktree } from '@/engine/worktree'
import { POST } from '@/app/api/runs/[runId]/delivery/route'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/** A person's project, and a finished run whose worktree (a real git worktree of it) holds a change. */
async function finishedRun(options: { approved?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'factory-project-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'me@example.com')
  git(repo, 'config', 'user.name', 'me')
  writeFileSync(join(repo, 'page.tsx'), 'button: white\nfooter: same\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'mine')
  const projectId = ulid()
  const workflowId = ulid()
  db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: repo }).run()
  db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() }).run()
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'Outline buttons in the other team colour' })
  const ws = createRunWorktree(repo, runId, mkdtempSync(join(tmpdir(), 'factory-wts-')))
  db.update(runs).set({ status: 'completed', worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }).where(eq(runs.id, runId)).run()
  // The agent's work: an edit and a new file, uncommitted, as it leaves them.
  writeFileSync(join(ws.path, 'page.tsx'), 'button: outline\nfooter: same\n')
  writeFileSync(join(ws.path, 'Button.tsx'), 'export const B = 1\n')
  const human = db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.blockId === 'human')!
  if (options.approved !== false) {
    db.insert(approvals).values({ id: ulid(), projectId, runId, nodeRunId: human.id, decision: 'approved', actor: 'me', diffHash: 'h', createdAt: now(), consumedAt: now() }).run()
  }
  return { runId, repo, wt: ws.path, branch: ws.branch, base: ws.baseCommit }
}

test('an approved change lands in the project uncommitted, and is kept as a commit on its own local branch', async () => {
  const { runId, repo, wt, branch, base } = await finishedRun()
  const delivered = deliverToProject(runId)
  // In their folder, on their branch, not committed: theirs to look at and commit.
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: outline\nfooter: same\n')
  expect(existsSync(join(repo, 'Button.tsx'))).toBe(true)
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base) // nothing committed in their branch
  expect(git(repo, 'diff', '--cached', '--name-only')).toBe('') // and nothing staged
  // Kept: one commit on factory/<run>, visible from their repo, saying what it was and that a person approved it.
  expect(git(repo, 'log', '-1', '--format=%s', branch)).toBe('Outline buttons in the other team colour')
  expect(git(repo, 'log', '-1', '--format=%b', branch)).toContain('approved by a person')
  expect(git(wt, 'status', '--porcelain')).toBe('')
  expect(delivered).toMatchObject({ delivered: true, branch, files: ['Button.tsx', 'page.tsx'], appliedTo: repo })
  expect((await eventsSince(runId, 0)).map(e => e.type)).toContain('run.delivered')
})

test('delivering twice does nothing the second time', async () => {
  const { runId, repo } = await finishedRun()
  deliverToProject(runId)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'I committed it')
  const before = git(repo, 'rev-parse', 'HEAD')
  expect(deliverToProject(runId).delivered).toBe(true)
  expect(git(repo, 'status', '--porcelain')).toBe('')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
})

test('with unsaved work in the project, nothing is applied and nothing is committed anywhere', async () => {
  const { runId, repo, branch, base } = await finishedRun()
  writeFileSync(join(repo, 'notes.md'), 'my own work in progress\n')
  expect(() => deliverToProject(runId)).toThrow(strings.delivery.dirty)
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: white\nfooter: same\n')
  expect(git(repo, 'rev-parse', branch)).toBe(base)
  expect(deliveryState(runId).delivered).toBe(false)
})

test('if the project changed the same lines since, it is refused whole and the project is untouched', async () => {
  const { runId, repo } = await finishedRun()
  writeFileSync(join(repo, 'page.tsx'), 'button: red\nfooter: same\n')
  git(repo, 'commit', '-qam', 'I changed it too')
  expect(() => deliverToProject(runId)).toThrow(DeliveryError)
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: red\nfooter: same\n')
  expect(existsSync(join(repo, 'Button.tsx'))).toBe(false)
  expect(git(repo, 'status', '--porcelain')).toBe('')
})

test('a run nobody approved cannot be brought over', async () => {
  const { runId, repo } = await finishedRun({ approved: false })
  expect(deliveryState(runId).eligible).toBe(false)
  expect(() => deliverToProject(runId)).toThrow(strings.delivery.notEligible)
  expect(git(repo, 'status', '--porcelain')).toBe('')
})

test('only the app\'s own page can write into the project', async () => {
  const { runId, repo } = await finishedRun()
  const res = await POST(new Request(`http://localhost:4100/api/runs/${runId}/delivery`, { method: 'POST', headers: { host: 'localhost:4100' } }), {
    params: Promise.resolve({ runId }),
  })
  expect(res.status).toBe(403)
  expect(git(repo, 'status', '--porcelain')).toBe('')
})

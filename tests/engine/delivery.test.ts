import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { approvals, events, nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { appendEvent, eventsSince } from '@/engine/events'
import { deliverToProject, DeliveryError, deliveryState, githubPullUrl, pushBranch, switchBack, switchToBranch } from '@/engine/delivery'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { createRunWorktree } from '@/engine/worktree'
import { POST } from '@/app/api/runs/[runId]/delivery/route'
import { strings } from '@/ui/strings'
import { fakeGitHubOrigin } from '../fake-github'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/** A person's project, and a finished run whose worktree (a real git worktree of it) holds a change. */
async function finishedRun(options: { approved?: boolean; passedByApp?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'factory-project-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'me@example.com')
  git(repo, 'config', 'user.name', 'me')
  writeFileSync(join(repo, 'page.tsx'), 'button: white\nfooter: same\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'mine')
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: repo })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'Outline buttons in the other team colour' })
  const ws = createRunWorktree(repo, runId, mkdtempSync(join(tmpdir(), 'factory-wts-')))
  await db.update(runs).set({ status: 'completed', worktreePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit }).where(eq(runs.id, runId))
  // The agent's work: an edit and a new file, uncommitted, as it leaves them.
  writeFileSync(join(ws.path, 'page.tsx'), 'button: outline\nfooter: same\n')
  writeFileSync(join(ws.path, 'Button.tsx'), 'export const B = 1\n')
  const human = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'human')!
  if (options.passedByApp) {
    // As the executor records a gate it passed on its own (passLowRiskGate): node passed, node.completed with autoApproved.
    await db.update(nodeRuns).set({ state: 'passed', summary: strings.risk.passedLow }).where(eq(nodeRuns.id, human.id))
    await appendEvent({ runId, nodeRunId: human.id, type: 'node.completed', payload: { blockId: 'human', summary: strings.risk.passedLow, summarySource: 'system', autoApproved: true } })
  } else if (options.approved !== false) {
    await db.insert(approvals).values({ id: ulid(), projectId, runId, nodeRunId: human.id, decision: 'approved', actor: 'me', diffHash: 'h', createdAt: now(), consumedAt: now() })
  }
  return { runId, repo, workflowId, wt: ws.path, branch: ws.branch, base: ws.baseCommit }
}

test('an approved change lands in the project uncommitted, and is kept as a commit on its own local branch', async () => {
  const { runId, repo, wt, branch, base } = await finishedRun()
  const delivered = (await deliverToProject(runId))
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
  await deliverToProject(runId)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'I committed it')
  const before = git(repo, 'rev-parse', 'HEAD')
  expect((await deliverToProject(runId)).delivered).toBe(true)
  expect(git(repo, 'status', '--porcelain')).toBe('')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
})

test('with unsaved work in the project, nothing is applied and nothing is committed anywhere', async () => {
  const { runId, repo, branch, base } = await finishedRun()
  writeFileSync(join(repo, 'notes.md'), 'my own work in progress\n')
  await expect(deliverToProject(runId)).rejects.toThrow(strings.delivery.dirty)
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: white\nfooter: same\n')
  expect(git(repo, 'rev-parse', branch)).toBe(base)
  expect((await deliveryState(runId)).delivered).toBe(false)
})

test('if the project changed the same lines since, it is refused whole and the project is untouched', async () => {
  const { runId, repo } = await finishedRun()
  writeFileSync(join(repo, 'page.tsx'), 'button: red\nfooter: same\n')
  git(repo, 'commit', '-qam', 'I changed it too')
  await expect(deliverToProject(runId)).rejects.toThrow(DeliveryError)
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: red\nfooter: same\n')
  expect(existsSync(join(repo, 'Button.tsx'))).toBe(false)
  expect(git(repo, 'status', '--porcelain')).toBe('')
})

test('a run nobody approved cannot be brought over', async () => {
  const { runId, repo } = await finishedRun({ approved: false })
  expect((await deliveryState(runId)).eligible).toBe(false)
  await expect(deliverToProject(runId)).rejects.toThrow(strings.delivery.notEligible)
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

// ---- follow-ups ---------------------------------------------------------------------------------------------------

import { startFollowUp } from '@/engine/follow-up'
import { orchestrateRun, type StepApi } from '@/engine/inngest/execute-run'
import type { AgentProvider } from '@/providers/types'

class Parked extends Error {}
const parkStep: StepApi = {
  run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
  waitForEvent: async () => {
    throw new Parked()
  },
}

/** A builder that records what it was asked and writes one more line into page.tsx. */
function lineWriter(line: string) {
  const seen: { previousRequest?: string; request: string }[] = []
  const provider: AgentProvider = {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      if (input.blockKind === 'build') {
        seen.push({ previousRequest: input.previousRequest, request: input.request })
        const fs = await import('node:fs')
        fs.appendFileSync(join(input.workdir!, 'page.tsx'), `${line}\n`)
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  return { provider, seen }
}

test('a follow-up starts from the approved change, is told about it, and its check shows only what is new', async () => {
  const { runId: parentId, repo } = await finishedRun()
  const { runId } = await startFollowUp(parentId, 'Make the text uppercase')
  const { provider, seen } = lineWriter('text: uppercase')
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  try {
    await orchestrateRun(runId, parkStep, { resolveProvider: () => provider })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  expect(seen).toEqual([{ previousRequest: 'Outline buttons in the other team colour', request: 'Make the text uppercase' }])
  const child = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!
  // Its worktree already holds the parent's change...
  expect(readFileSync(join(child.worktreePath!, 'page.tsx'), 'utf8')).toBe('button: outline\nfooter: same\ntext: uppercase\n')
  // ...and what it is judged on is only the new line.
  const { changeUnderReview } = await import('@/engine/approvals')
  expect((await changeUnderReview(runId))!.files).toEqual([{ path: 'page.tsx', added: 1, removed: 0 }])
  expect(child.parentRunId).toBe(parentId)
  // The person's project is still untouched: nothing is brought over until they say so.
  expect(git(repo, 'status', '--porcelain')).toBe('')
})

test('a follow-up and a picked-up failed task keep the parent\'s "stop for me"', async () => {
  const done = await finishedRun()
  await db.update(runs).set({ stopForMe: true }).where(eq(runs.id, done.runId))
  const followUp = await startFollowUp(done.runId, 'uppercase')
  expect((await db.select().from(runs).where(eq(runs.id, followUp.runId)))[0]!.stopForMe).toBe(true)
  const failed = await failedRun()
  expect((await db.select().from(runs).where(eq(runs.id, failed.runId)))[0]!.stopForMe).toBe(false)
  await db.update(runs).set({ stopForMe: true }).where(eq(runs.id, failed.runId))
  const picked = await startFollowUp(failed.runId, 'Fix it')
  expect((await db.select().from(runs).where(eq(runs.id, picked.runId)))[0]!.stopForMe).toBe(true)
})

test('bringing a follow-up over carries its parent along when the parent was never brought over', async () => {
  const { runId: parentId, repo } = await finishedRun()
  const { runId } = await startFollowUp(parentId, 'uppercase')
  const { provider } = lineWriter('text: uppercase')
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  try {
    await orchestrateRun(runId, parkStep, { resolveProvider: () => provider })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  await approveAndFinish(runId)
  await deliverToProject(runId)
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: outline\nfooter: same\ntext: uppercase\n')
  expect(existsSync(join(repo, 'Button.tsx'))).toBe(true)
})

test('when the parent was already brought over, the follow-up brings only its own change', async () => {
  const { runId: parentId, repo } = await finishedRun()
  await deliverToProject(parentId)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'took the first change')
  const { runId } = await startFollowUp(parentId, 'uppercase')
  const { provider } = lineWriter('text: uppercase')
  await db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId))
  try {
    await orchestrateRun(runId, parkStep, { resolveProvider: () => provider })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  await approveAndFinish(runId)
  expect((await deliverToProject(runId)).files).toEqual(['page.tsx'])
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: outline\nfooter: same\ntext: uppercase\n')
})

test('a follow-up needs a note, and a parent that was approved and finished', async () => {
  const { runId } = await finishedRun({ approved: false })
  await expect(startFollowUp(runId, 'x')).rejects.toThrow(strings.followUp.notEligible)
  const ok = await finishedRun()
  await expect(startFollowUp(ok.runId, '  ')).rejects.toThrow(strings.followUp.needNote)
})

async function approveAndFinish(runId: string) {
  const human = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'human')!
  await db.insert(approvals).values({ id: ulid(), projectId: human.projectId, runId, nodeRunId: human.id, decision: 'approved', actor: 'me', diffHash: 'h', createdAt: now(), consumedAt: now() })
  await db.update(runs).set({ status: 'completed' }).where(eq(runs.id, runId))
}

// ---- keep it on its own branch ------------------------------------------------------------------------------------

import { keepOnBranch } from '@/engine/delivery'

test('keeping it on its own branch commits it there and leaves the person\'s checkout exactly as it was', async () => {
  const { runId, repo, branch, base } = await finishedRun()
  const kept = (await keepOnBranch(runId))
  expect(kept).toMatchObject({ kept: true, delivered: false, branch, files: ['Button.tsx', 'page.tsx'] })
  expect(git(repo, 'log', '-1', '--format=%s', branch)).toBe('Outline buttons in the other team colour')
  expect(git(repo, 'show', `${branch}:page.tsx`)).toBe('button: outline\nfooter: same')
  // Their side: same branch, same commit, same files, nothing pending.
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(git(repo, 'status', '--porcelain')).toBe('')
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: white\nfooter: same\n')
})

test('keeping works even with unsaved work in the project, because it does not touch the checkout', async () => {
  const { runId, repo } = await finishedRun()
  writeFileSync(join(repo, 'notes.md'), 'mine\n')
  expect((await keepOnBranch(runId)).kept).toBe(true)
  expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('mine\n')
})

test('a run from before readable names gets one when it is kept', async () => {
  const { runId, repo, wt } = await finishedRun()
  git(wt, 'branch', '-m', `factory/${runId.toLowerCase()}`)
  await db.update(runs).set({ branch: `factory/${runId.toLowerCase()}` }).where(eq(runs.id, runId))
  const kept = (await keepOnBranch(runId))
  expect(kept.branch).toMatch(/^ai\/outline-buttons-other-team-colour-[a-z0-9]{6}$/)
  expect(git(repo, 'branch', '--list', 'factory/*')).toBe('')
  expect(git(repo, 'log', '-1', '--format=%s', kept.branch!)).toBe('Outline buttons in the other team colour')
})

test('applying after keeping reuses the kept commit: one commit, not two', async () => {
  const { runId, repo, branch, base } = await finishedRun()
  const kept = (await keepOnBranch(runId))
  const applied = (await deliverToProject(runId))
  expect(applied.commit).toBe(kept.commit)
  expect(git(repo, 'rev-list', '--count', `${base}..${branch}`)).toBe('1')
  expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: outline\nfooter: same\n')
})

describe('switching the project to the kept branch', () => {
  test('puts the project on the kept branch, says so, and switches back to where it was', async () => {
    const { runId, repo } = await finishedRun()
    const kept = (await keepOnBranch(runId))
    expect((await deliveryState(runId)).current).toBe('main')
    const switched = (await switchToBranch(runId))
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(kept.branch)
    expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: outline\nfooter: same\n')
    expect(switched.current).toBe(kept.branch)
    expect(switched.returnTo).toBe('main')
    expect((await eventsSince(runId, 0)).some(e => e.type === 'run.switched')).toBe(true)
    const back = (await switchBack(runId))
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('button: white\nfooter: same\n')
    expect(back.current).toBe('main')
  })

  test('refuses, changing nothing, when the project has unsaved work', async () => {
    const { runId, repo } = await finishedRun()
    await keepOnBranch(runId)
    writeFileSync(join(repo, 'page.tsx'), 'my own edit\n')
    await expect(switchToBranch(runId)).rejects.toThrow(strings.delivery.dirty)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(readFileSync(join(repo, 'page.tsx'), 'utf8')).toBe('my own edit\n')
  })

  test('refuses before the change is kept on its branch', async () => {
    const { runId } = await finishedRun()
    await expect(switchToBranch(runId)).rejects.toThrow(DeliveryError)
  })

  test('switching back needs an earlier switch', async () => {
    const { runId } = await finishedRun()
    await keepOnBranch(runId)
    await expect(switchBack(runId)).rejects.toThrow(DeliveryError)
  })

  test('the state follows the real checkout, even when the person switched by hand', async () => {
    const { runId, repo } = await finishedRun()
    const kept = (await keepOnBranch(runId))
    await switchToBranch(runId)
    git(repo, 'checkout', '-q', 'main')
    expect((await deliveryState(runId)).current).toBe('main')
    expect(kept.branch).not.toBe('main')
  })

  test('the route takes switch and back', async () => {
    const { runId, repo } = await finishedRun()
    await keepOnBranch(runId)
    const post = (mode: string) =>
      POST(
        new Request(`http://127.0.0.1/api/runs/${runId}/delivery`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:4100' },
          body: JSON.stringify({ mode }),
        }),
        { params: Promise.resolve({ runId }) },
      )
    expect((await post('switch')).status).toBe(200)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe('main')
    expect((await post('back')).status).toBe(200)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })
})

describe('naming the kept branch', () => {
  test('the name the person typed is used as it is', async () => {
    const { runId, repo } = await finishedRun()
    const kept = (await keepOnBranch(runId, { name: 'feature/watch-buttons' }))
    expect(kept.branch).toBe('feature/watch-buttons')
    expect(git(repo, 'log', '-1', '--format=%s', 'feature/watch-buttons')).toBe('Outline buttons in the other team colour')
  })

  test('an automatic name is replaced by the suggested one', async () => {
    const { runId, wt } = await finishedRun()
    const { branchNameFor } = await import('@/engine/worktree')
    const auto = branchNameFor(runId, 'Outline buttons in the other team colour')
    git(wt, 'branch', '-m', auto)
    await db.update(runs).set({ branch: auto }).where(eq(runs.id, runId))
    expect((await keepOnBranch(runId, { fallbackName: 'ai/outline-buttons-abc123' })).branch).toBe('ai/outline-buttons-abc123')
  })

  test('an unusable name is refused and nothing is kept', async () => {
    const { runId } = await finishedRun()
    for (const bad of ['has space', '-dash', 'a..b', 'x.lock', 'end/', '$(evil)', 'ü']) {
      await expect(keepOnBranch(runId, { name: bad })).rejects.toThrow(strings.delivery.badBranchName)
    }
    expect((await deliveryState(runId)).kept).toBe(false)
  })

  test('a name already taken is refused and nothing is kept', async () => {
    const { runId, repo } = await finishedRun()
    git(repo, 'branch', 'taken')
    await expect(keepOnBranch(runId, { name: 'taken' })).rejects.toThrow(strings.delivery.branchExists('taken'))
    expect((await deliveryState(runId)).kept).toBe(false)
  })
})

describe('pushing the kept branch', () => {
  async function withOrigin() {
    const r = await finishedRun()
    const origin = mkdtempSync(join(tmpdir(), 'factory-origin-'))
    git(origin, 'init', '-q', '--bare')
    git(r.repo, 'remote', 'add', 'origin', origin)
    return { ...r, origin }
  }

  test('sends only the kept branch to origin, and says so', async () => {
    const { runId, origin } = await withOrigin()
    const kept = (await keepOnBranch(runId, { name: 'ai/outline-buttons-x1' }))
    const pushed = await pushBranch(runId)
    expect(pushed.pushed).toBe(true)
    expect(git(origin, 'rev-parse', 'ai/outline-buttons-x1')).toBe(git(origin, 'rev-parse', kept.commit!))
    expect(git(origin, 'branch', '--list', 'main')).toBe('') // their main was not sent
    expect((await eventsSince(runId, 0)).some(e => e.type === 'run.pushed')).toBe(true)
  })

  test('refuses before the change is kept, and without an origin', async () => {
    const { runId } = await finishedRun()
    await expect(pushBranch(runId)).rejects.toThrow(strings.delivery.keepFirst)
    await keepOnBranch(runId)
    await expect(pushBranch(runId)).rejects.toThrow(strings.delivery.noRemote)
  })

  test('a push git refuses is reported, never forced', async () => {
    const { runId, repo, origin } = await withOrigin()
    await keepOnBranch(runId, { name: 'ai/taken-remotely' })
    // Someone else's commit is already on that branch name at origin.
    const other = mkdtempSync(join(tmpdir(), 'factory-other-'))
    git(other, 'clone', '-q', origin, '.')
    git(other, 'config', 'user.email', 'o@example.com')
    git(other, 'config', 'user.name', 'o')
    git(other, 'checkout', '-q', '--orphan', 'ai/taken-remotely')
    writeFileSync(join(other, 'x.txt'), 'theirs\n')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'theirs')
    git(other, 'push', '-q', 'origin', 'ai/taken-remotely')
    const before = git(origin, 'rev-parse', 'ai/taken-remotely')
    await expect(pushBranch(runId)).rejects.toThrow(DeliveryError)
    expect(git(origin, 'rev-parse', 'ai/taken-remotely')).toBe(before)
    expect((await deliveryState(runId)).pushed).toBe(false)
    expect(repo).toBeTruthy()
  })

  test('a GitHub remote gives a pull-request link, without any credentials in it', () => {
    expect(githubPullUrl('https://github.com/alice/shop.git', 'ai/x-1')).toBe('https://github.com/alice/shop/pull/new/ai/x-1')
    expect(githubPullUrl('git@github.com:alice/shop.git', 'ai/x-1')).toBe('https://github.com/alice/shop/pull/new/ai/x-1')
    expect(githubPullUrl('https://alice:ghp_secret@github.com/alice/shop', 'b')).toBe('https://github.com/alice/shop/pull/new/b')
    expect(githubPullUrl('https://gitlab.com/alice/shop.git', 'b')).toBeNull()
    expect(githubPullUrl('/tmp/bare', 'b')).toBeNull()
  })
})

test('a suggested commit message is used, with the provenance line kept', async () => {
  const { runId, repo } = await finishedRun()
  const kept = (await keepOnBranch(runId, { message: { subject: 'Outline the buttons and add Button', body: '- outline style\n- new Button component' } }))
  expect(git(repo, 'log', '-1', '--format=%s', kept.branch!)).toBe('Outline the buttons and add Button')
  const body = git(repo, 'log', '-1', '--format=%b', kept.branch!)
  expect(body).toContain('- new Button component')
  expect(body).toContain('approved by a person')
  expect(body).toContain('Asked for: Outline buttons in the other team colour')
})

test('the request in the commit, which can leave the computer in a pull request, has its secrets taken out', async () => {
  const { runId, repo } = await finishedRun()
  await db.update(runs).set({ request: 'Use the key API_KEY=supersecret123 for the outline buttons' }).where(eq(runs.id, runId))
  const kept = (await keepOnBranch(runId, { message: { subject: 'Outline the buttons', body: '' } }))
  const body = git(repo, 'log', '-1', '--format=%b', kept.branch!)
  expect(body).toContain('Asked for: Use the key')
  expect(body).not.toContain('supersecret123')
})

describe('deleting a task', () => {
  test('removes its record and its working copy, and keeps the saved branch in the project', async () => {
    const { deleteRun } = await import('@/engine/run-delete')
    const { runId, repo, wt } = await finishedRun()
    const kept = (await keepOnBranch(runId, { name: 'ai/keep-me' }))
    await deleteRun(runId, { worktreeRoot: join(wt, '..') })
    expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]).toBeUndefined()
    expect(await eventsSince(runId, 0)).toHaveLength(0)
    expect(existsSync(wt)).toBe(false)
    expect(git(repo, 'rev-parse', 'ai/keep-me')).toBe(kept.commit)
  })

  test('a task still working or waiting for a decision cannot be deleted', async () => {
    const { deleteRun, RunDeleteError } = await import('@/engine/run-delete')
    const { runId } = await finishedRun()
    for (const status of ['running', 'queued', 'waiting_approval'] as const) {
      await db.update(runs).set({ status }).where(eq(runs.id, runId))
      await expect(deleteRun(runId)).rejects.toThrow(RunDeleteError)
    }
    expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]).toBeDefined()
  })

  test('a working copy outside the app\'s own folder is never removed', async () => {
    const { deleteRun } = await import('@/engine/run-delete')
    const { runId, wt } = await finishedRun()
    await deleteRun(runId, { worktreeRoot: '/somewhere/else' })
    expect(existsSync(wt)).toBe(true)
  })
})

describe('shipping through GitHub', () => {
  async function shippable() {
    const r = await finishedRun()
    const origin = mkdtempSync(join(tmpdir(), 'factory-ship-origin-'))
    git(origin, 'init', '-q', '--bare')
    fakeGitHubOrigin(r.repo, origin)
    await keepOnBranch(r.runId, { name: 'ai/ship-me' })
    return r
  }
  type View = Record<string, unknown>
  // As if the pull request was opened a while ago: GitHub has had time to list its checks.
  async function aged(runId: string) {
    await db.update(events).set({ createdAt: '2000-01-01T00:00:00.000Z' }).where(and(eq(events.runId, runId), eq(events.type, 'run.pr_opened')))
  }
  function fakeGh(view: () => View, extra: (args: string[]) => string | undefined = () => undefined) {
    const calls: string[][] = []
    const gh = async (args: string[]) => {
      calls.push(args)
      const custom = extra(args)
      if (custom !== undefined) return custom
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(view())
      if (args[0] === 'api') return JSON.stringify(args[1]!.endsWith('/status') ? { statuses: [{ context: 'Deploy', state: 'success', target_url: 'https://site' }] } : { check_runs: [] })
      return ''
    }
    return { gh, calls }
  }

  test('opens a pull request once, after pushing, and reads any checks the repository runs', async () => {
    const { openPullRequest } = await import('@/engine/ship')
    const { runId } = await shippable()
    let opened = false
    const { gh, calls } = fakeGh(
      () => (opened ? { number: 7, url: 'https://gh/pr/7', state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS', conclusion: null }], mergeCommit: null, mergedAt: null } : { number: 0, url: '', state: 'CLOSED' }),
      args => (args[1] === 'create' ? ((opened = true), '') : undefined),
    )
    const state = await openPullRequest(runId, gh)
    expect(state.pr).toMatchObject({ number: 7, state: 'open' })
    expect(state.checks).toEqual([{ name: 'CI', state: 'pending', url: null }])
    expect(state.checksDone).toBe(false)
    expect((await deliveryState(runId)).pushed).toBe(true)
    await openPullRequest(runId, gh)
    expect(calls.filter(c => c[1] === 'create')).toHaveLength(1)
  })

  test('a repository with no checks has nothing to wait for', async () => {
    const { openPullRequest } = await import('@/engine/ship')
    const { runId } = await shippable()
    const { gh } = fakeGh(() => ({ number: 3, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], mergeCommit: null, mergedAt: null }))
    const { shipState } = await import('@/engine/ship')
    // Right after opening, no checks yet is not taken as none.
    expect((await openPullRequest(runId, gh)).checksDone).toBe(false)
    await aged(runId)
    const state = await shipState(runId, gh)
    expect(state.checks).toEqual([])
    expect(state.checksDone).toBe(true)
  })

  test('merging waits for checks, refuses a failure or a conflict, and squash-merges when allowed', async () => {
    const { openPullRequest, mergePullRequest, ShipError } = await import('@/engine/ship')
    const { runId } = await shippable()
    let view: View = { number: 5, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'StatusContext', context: 'Vercel', state: 'PENDING' }], mergeCommit: null, mergedAt: null }
    const { gh, calls } = fakeGh(() => view, args => (args[1] === 'merge' ? ((view = { ...view, state: 'MERGED', mergeCommit: { oid: 'abc' }, mergedAt: 'now' }), '') : undefined))
    await openPullRequest(runId, gh)
    await expect(mergePullRequest(runId, gh)).rejects.toThrow(strings.ship.checksRunning)
    view = { ...view, statusCheckRollup: [{ __typename: 'StatusContext', context: 'Vercel', state: 'FAILURE' }] }
    await expect(mergePullRequest(runId, gh)).rejects.toThrow(strings.ship.checksFailed)
    view = { ...view, statusCheckRollup: [{ __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS' }], mergeable: 'CONFLICTING' }
    await expect(mergePullRequest(runId, gh)).rejects.toBeInstanceOf(ShipError)
    view = { ...view, mergeable: 'MERGEABLE' }
    const merged = await mergePullRequest(runId, gh)
    expect(calls.find(c => c[1] === 'merge')).toEqual(['pr', 'merge', '5', '--repo', 'ai-factory-test/never-real', '--squash'])
    expect(merged.pr!.state).toBe('merged')
    expect(merged.deploy).toEqual([{ name: 'Deploy', state: 'passed', url: 'https://site' }])
  })

  test('a ready pull request can be put on hold and taken off it; the task list says so; merging ends the hold', async () => {
    const { openPullRequest, mergePullRequest, setHold, ShipError } = await import('@/engine/ship')
    const { listRuns } = await import('@/engine/run')
    const r = await shippable()
    let view: View = { number: 6, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], mergeCommit: null, mergedAt: null }
    const { gh } = fakeGh(() => view, args => (args[1] === 'merge' ? ((view = { ...view, state: 'MERGED', mergeCommit: { oid: 'abc' }, mergedAt: 'now' }), '') : undefined))
    const onHoldInList = async () => (await listRuns(r.workflowId)).find(x => x.runId === r.runId)!.onHold
    // Nothing to hold before there is a pull request.
    await expect(setHold(r.runId, true, gh)).rejects.toBeInstanceOf(ShipError)
    expect((await openPullRequest(r.runId, gh)).onHold).toBe(false)
    await aged(r.runId)
    expect((await onHoldInList())).toBe(false)
    expect((await setHold(r.runId, true, gh)).onHold).toBe(true)
    expect((await onHoldInList())).toBe(true)
    expect((await setHold(r.runId, false, gh)).onHold).toBe(false)
    expect((await onHoldInList())).toBe(false)
    await setHold(r.runId, true, gh)
    const merged = await mergePullRequest(r.runId, gh)
    expect(merged.onHold).toBe(false)
    expect((await onHoldInList())).toBe(false)
  })

  test('a branch sent before the app opened pull requests finds the one GitHub has, and shows it as merged', async () => {
    const { shipState } = await import('@/engine/ship')
    const { pushBranch } = await import('@/engine/delivery')
    const { runId } = await shippable()
    // Nothing sent yet: nothing is looked up.
    const { gh, calls } = fakeGh(
      () => ({ number: 3, url: 'https://gh/pr/3', state: 'MERGED', mergeable: 'UNKNOWN', statusCheckRollup: [], mergeCommit: { oid: 'abc' }, mergedAt: 'then' }),
      args => (args[1] === 'list' ? JSON.stringify([{ number: 3, url: 'https://gh/pr/3', baseRefName: 'main' }]) : undefined),
    )
    expect((await shipState(runId, gh)).pr).toBeNull()
    expect(calls.some(c => c[1] === 'list')).toBe(false)
    await pushBranch(runId)
    const state = await shipState(runId, gh)
    expect(state.pr).toMatchObject({ number: 3, state: 'merged' })
    // Recorded once: later reads use the record.
    await shipState(runId, gh)
    expect(calls.filter(c => c[1] === 'list')).toHaveLength(1)
  })

  test('no gh on the computer is said plainly', async () => {
    const { openPullRequest } = await import('@/engine/ship')
    const { runId } = await shippable()
    const gh = async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    }
    await expect(openPullRequest(runId, gh)).rejects.toThrow(strings.ship.noGh)
  })
})

// ---- picking up a failed run ----------------------------------------------------------------------------------------

import { runFailure } from '@/engine/failure'
import { evidence } from '@/db/schema'

/** A run whose build check failed, with the agent's work still in its worktree. */
async function failedRun() {
  const made = await finishedRun({ approved: false })
  await db.update(runs).set({ status: 'failed', providerId: 'files' }).where(eq(runs.id, made.runId))
  const node = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, made.runId))).find(n => n.blockId === 'tests')!
  await db.update(nodeRuns).set({ state: 'failed', failureCause: 'tests_failed' }).where(eq(nodeRuns.id, node.id))
  // Its plan was checked and built from before the check failed.
  for (const n of (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, made.runId))).filter(n => n.blockId.startsWith('plan'))) {
    await db.update(nodeRuns).set({ state: 'passed' }).where(eq(nodeRuns.id, n.id))
  }
  const project = (await db.select().from(runs).where(eq(runs.id, made.runId)))[0]!.projectId
  await db.insert(evidence).values({ id: ulid(), projectId: project, runId: made.runId, nodeRunId: node.id, kind: 'test_run', source: 'test-runner', dataJson: JSON.stringify({ command: 'npm run build', exitCode: 1, signal: null, outputTail: 'Type error: missing prop\n' }), createdAt: now() })
  return made
}

test('what went wrong names the failed block, its command and what it printed, and says the work can be picked up', async () => {
  const { runId } = await failedRun()
  const failure = (await runFailure(runId))!
  expect(failure.canContinue).toBe(true)
  expect(failure.failed).toMatchObject([{ blockId: 'tests', command: 'npm run build', exitCode: 1, output: 'Type error: missing prop' }])
  expect(await runFailure('nope')).toBeNull()
})

test('a failed run is picked up where it stopped: the new run starts from its work, and its check shows the whole change', async () => {
  const { runId: parentId, repo, base } = await failedRun()
  const { runId } = await startFollowUp(parentId, 'Fix the build error')
  const { provider, seen } = lineWriter('text: fixed')
  try {
    await orchestrateRun(runId, parkStep, { resolveProvider: () => provider })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  expect(seen[0]?.request).toBe('Fix the build error')
  const child = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!
  // The agent's unfinished work is there, plus the fix...
  expect(readFileSync(join(child.worktreePath!, 'page.tsx'), 'utf8')).toBe('button: outline\nfooter: same\ntext: fixed\n')
  expect(existsSync(join(child.worktreePath!, 'Button.tsx'))).toBe(true)
  // ...and since nobody approved that work, the person is shown all of it, from where the failed run began.
  expect(child.baseCommit).toBe(base)
  const { changeUnderReview } = await import('@/engine/approvals')
  expect((await changeUnderReview(runId))!.files.map(f => f.path).sort()).toEqual(['Button.tsx', 'page.tsx'])
  expect(child.parentRunId).toBe(parentId)
  // The plan was checked on the failed run, so this one does not make or ask about it again.
  const planBlocks = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).filter(n => n.blockId.startsWith('plan'))
  expect(planBlocks.length).toBeGreaterThan(0)
  expect(planBlocks.every(n => n.state === 'skipped')).toBe(true)
  // The saved work says it was never approved, and the person's project is untouched.
  expect(git(repo, 'log', '-1', '--format=%B', (await db.select().from(runs).where(eq(runs.id, parentId)))[0]!.branch!)).toContain('stopped before a person approved it')
  expect(git(repo, 'status', '--porcelain')).toBe('')
})

test('a failed run whose working copy is gone cannot be picked up, and says so', async () => {
  const { runId } = await failedRun()
  await db.update(runs).set({ worktreePath: '/nowhere/at/all' }).where(eq(runs.id, runId))
  expect((await runFailure(runId))!.canContinue).toBe(false)
  await expect(startFollowUp(runId, 'again')).rejects.toThrow(strings.failure.cannotContinue)
})

test('a run the app passed is eligible to keep, send and continue, like one a person approved', async () => {
  const { runId, repo } = await finishedRun({ passedByApp: true })
  const state = await deliveryState(runId)
  expect(state).toMatchObject({ eligible: true, passedBy: 'app' })
  const kept = await keepOnBranch(runId)
  expect(kept.kept).toBe(true)
  expect(git(repo, 'rev-parse', kept.branch!)).toBe(kept.commit)
  const followUp = await startFollowUp(runId, 'uppercase')
  const child = (await db.select().from(runs).where(eq(runs.id, followUp.runId)))[0]!
  expect(child.parentRunId).toBe(runId)
  expect(child.baseCommit).toBe(kept.commit)
})

test('a kept commit says who passed the human check: a person, or the app on its own', async () => {
  const byApp = await finishedRun({ passedByApp: true })
  const keptByApp = await keepOnBranch(byApp.runId)
  const appBody = git(byApp.repo, 'log', '-1', '--format=%b', keptByApp.branch!)
  expect(appBody).toContain(strings.delivery.passedOnItsOwn)
  expect(appBody).not.toContain('approved by a person')
  const byPerson = await finishedRun()
  const keptByPerson = await keepOnBranch(byPerson.runId)
  expect(git(byPerson.repo, 'log', '-1', '--format=%b', keptByPerson.branch!)).toContain('and approved by a person.')
})

test('continuing from a run keeps its change with the same honest sentence', async () => {
  const byApp = await finishedRun({ passedByApp: true })
  await startFollowUp(byApp.runId, 'uppercase')
  const appBody = git(byApp.repo, 'log', '-1', '--format=%b', byApp.branch)
  expect(appBody).toContain(strings.delivery.passedOnItsOwn)
  expect(appBody).not.toContain('approved by a person')
  const byPerson = await finishedRun()
  await startFollowUp(byPerson.runId, 'uppercase')
  expect(git(byPerson.repo, 'log', '-1', '--format=%b', byPerson.branch)).toContain('and approved by a person.')
})

test('a run a person approved says so, and a run nobody passed is not eligible', async () => {
  expect(await deliveryState((await finishedRun()).runId)).toMatchObject({ eligible: true, passedBy: 'person' })
  expect(await deliveryState((await finishedRun({ approved: false })).runId)).toMatchObject({ eligible: false, passedBy: null })
})

// ---- what keeping and sending on its own reuses ---------------------------------------------------------------------

describe('the pieces the automatic pull request reuses', () => {
  test('the Save button\'s naming: a model names the branch and describes the change before the first keep only', async () => {
    const { keepOptionsFor } = await import('@/engine/delivery-options')
    const { runId } = await finishedRun()
    const asked: string[] = []
    const ask = async (prompt: string) => (asked.push(prompt), prompt.startsWith('Name a git branch') ? 'outline-buttons' : 'Outline the buttons\n\n- border only')
    const options = await keepOptionsFor(runId, '', ask)
    expect(options).toEqual({ name: null, fallbackName: `ai/outline-buttons-${runId.slice(-6).toLowerCase()}`, message: { subject: 'Outline the buttons', body: '- border only' } })
    // A name the person typed is not asked for.
    expect((await keepOptionsFor(runId, 'mine/x', ask)).fallbackName).toBeNull()
    await keepOnBranch(runId, options)
    asked.length = 0
    expect(await keepOptionsFor(runId, '', ask)).toEqual({ name: null, fallbackName: null, message: null })
    expect(asked).toEqual([])
  })

  test('no origin is a missing connection, and nothing was tried on its own yet', async () => {
    const { runId } = await finishedRun()
    await keepOnBranch(runId)
    const err = await pushBranch(runId).catch(e => e as DeliveryError)
    expect(err).toBeInstanceOf(DeliveryError)
    expect((err as DeliveryError).kind).toBe('no_connection')
    expect((await deliveryState(runId)).autoShip).toBeNull()
  })

  test('sending the same branch twice is recorded once', async () => {
    const { runId, repo } = await finishedRun()
    git(repo, 'remote', 'add', 'origin', (() => {
      const o = mkdtempSync(join(tmpdir(), 'factory-twice-'))
      git(o, 'init', '-q', '--bare')
      return o
    })())
    await keepOnBranch(runId)
    await pushBranch(runId)
    await pushBranch(runId)
    expect((await eventsSince(runId, 0)).filter(e => e.type === 'run.pushed')).toHaveLength(1)
  })

  test('gh\'s missing pieces are a missing connection; anything else it says is not', async () => {
    const { openPullRequest, ShipError } = await import('@/engine/ship')
    const { runId, repo } = await finishedRun()
    const o = mkdtempSync(join(tmpdir(), 'factory-gh-'))
    git(o, 'init', '-q', '--bare')
    fakeGitHubOrigin(repo, o)
    await keepOnBranch(runId)
    for (const [said, kind] of [['To get started with GitHub CLI, please run:  gh auth login', 'no_connection'], ['none of the git remotes configured for this repository point to a known GitHub host', 'no_connection'], ['HTTP 502', undefined]] as const) {
      const err = await openPullRequest(runId, async () => {
        throw new Error(said)
      }).catch(e => e as InstanceType<typeof ShipError>)
      expect(err).toBeInstanceOf(ShipError)
      expect((err as InstanceType<typeof ShipError>).kind).toBe(kind)
    }
  })
})

test('the "not eligible" messages are true for a change the app passed on its own as well as for one a person approved', () => {
  for (const message of [strings.delivery.notEligible, strings.followUp.notEligible]) {
    expect(message).not.toMatch(/a person approved/)
    expect(message).toMatch(/by you or on its own/)
  }
})

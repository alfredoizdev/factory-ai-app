import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { db, migrateDb } from '@/db/client'
import { runs } from '@/db/schema'
import type { AskMode } from '@/domain/ask-mode'
import { autoKeep, autoOpen, autoSend, shouldShipOnItsOwn } from '@/engine/auto-ship'
import { deliveryState } from '@/engine/delivery'
import { eventsSince } from '@/engine/events'
import { APPROVAL_DECIDED, PLAN_DECIDED } from '@/engine/inngest/client'
import { afterRunGaveUp, orchestrateRun, type StepApi } from '@/engine/inngest/execute-run'
import { recordDecision } from '@/engine/approvals'
import { decidePlan } from '@/engine/plan'
import { createProject } from '@/engine/projects'
import { createRun } from '@/engine/run'
import type { Gh } from '@/engine/ship'
import { createRunWorktree } from '@/engine/worktree'
import { createDemoProvider } from '@/providers/demo'
import type { AgentProvider } from '@/providers/types'
import type { TestRun } from '@/engine/test-runner'
import { strings } from '@/ui/strings'
import { fakeGitHubOrigin } from '../fake-github'

// After a change passes, in "only what matters": kept on its branch, sent to GitHub and opened as a pull request, each
// on its own, each safe to run twice, and every missing piece or refusal said softly with the change still kept.
// `origin` is always a bare repository in a temporary folder, and `gh` is always a fake: nothing reaches GitHub.

beforeAll(() => migrateDb())
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/**
 * `github`: an origin that is GitHub by both its fetch and its push address, while git only ever talks to a bare
 * repository in a temporary folder (see fake-github.ts), and this repository may use no network protocol at all, so
 * nothing can reach a real host. `plain`: that bare repository as the origin itself, which is not GitHub. `missing`:
 * GitHub, but what is sent goes to a folder that does not exist. `none`: no origin.
 */
type Origin = 'github' | 'plain' | 'missing' | 'none'
const githubLooking = (dir: string, pushTo: string) => fakeGitHubOrigin(dir, pushTo)
/** A project made the way the app makes one, on a real folder with one commit, and where its origin points. */
async function project(origin: Origin, askMode: AskMode = 'everything') {
  const dir = mkdtempSync(join(tmpdir(), 'factory-auto-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'me@example.com')
  git(dir, 'config', 'user.name', 'me')
  writeFileSync(join(dir, 'README.md'), 'shop\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'mine')
  const bare = mkdtempSync(join(tmpdir(), 'factory-auto-origin-'))
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  if (origin === 'github') githubLooking(dir, bare)
  else if (origin === 'plain') git(dir, 'remote', 'add', 'origin', bare)
  else if (origin === 'missing') githubLooking(dir, join(mkdtempSync(join(tmpdir(), 'factory-auto-gone-')), 'not-here.git'))
  const { projectId, workflowId } = await createProject({ path: dir, name: 'Shop', testCommand: 'npm test', checks: [], askMode })
  return { dir, bare, projectId, workflowId }
}
/** Every branch the bare repository received. */
const branchesIn = (bare: string) => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')

const passing: TestRun = { command: 'npm test', exitCode: 0, signal: null, started: true, durationMs: 10, counts: { passed: 4, failed: 0, total: 4 }, outputTail: '', changedTestFiles: [] }
const failing: TestRun = { ...passing, exitCode: 1, counts: { passed: 3, failed: 1, total: 4 }, outputTail: 'FAIL' }

/** A builder that writes one file into the run's own copy; the tests pass (or fail), the reviewer finds nothing. */
function builder(file = 'src/ui/footer/Footer.tsx', tests: TestRun = passing): AgentProvider {
  return {
    id: 'files', isDemo: false, needsWorkspace: true,
    async *execute(input) {
      if (input.blockKind === 'build') {
        mkdirSync(dirname(join(input.workdir!, file)), { recursive: true })
        writeFileSync(join(input.workdir!, file), 'export const year = 2026\n')
      }
      if (input.blockKind === 'tests') {
        yield { type: 'evidence', kind: 'test_run', data: tests }
        if (tests.exitCode !== 0) {
          yield { type: 'error', message: 'tests failed', source: 'system', cause: 'tests_failed' }
          return
        }
      }
      if (input.blockKind === 'review') {
        yield { type: 'done', summary: 'ok', source: 'provider', review: { verdict: 'ok', findings: [] } }
        return
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
}

class Parked extends Error {}
/** The person checks the plan and approves the change whenever the run waits for them. */
function personSaysYes(runId: string): StepApi {
  return {
    run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
    waitForEvent: async (_id, opts) => {
      if (opts.event === PLAN_DECIDED) await decidePlan(runId, { action: 'build', jobs: [] })
      else if (opts.event === APPROVAL_DECIDED) await recordDecision(runId, 'approved', { actor: 'me', diffHash: null })
      else throw new Parked()
      return { data: { decision: 'approved' } }
    },
  }
}

/** A real run in a project that asks about everything, approved by the person: the run ships nothing on its own. */
async function approvedRun(origin: Origin, provider: AgentProvider = builder()) {
  const p = await project(origin)
  const { runId } = await createRun({ workflowId: p.workflowId, request: 'add a footer with the year' })
  await db.update(runs).set({ providerId: provider.id }).where(eq(runs.id, runId))
  const root = mkdtempSync(join(tmpdir(), 'factory-auto-wts-'))
  try {
    await orchestrateRun(runId, personSaysYes(runId), {
      resolveProvider: () => provider,
      createWorktree: (repo, id, start, request) => createRunWorktree(repo, id, root, start, request),
    })
  } catch (e) {
    if (!(e instanceof Parked)) throw e
  }
  return { ...p, runId }
}

/** A gh that records what it is asked, and answers like GitHub once a pull request was created. */
function fakeGh(fail?: string | Error): Gh & { calls: string[][] } {
  const calls: string[][] = []
  let opened = false
  const gh: Gh = async (args: string[]) => {
    calls.push(args)
    if (fail) throw typeof fail === 'string' ? new Error(fail) : fail
    if (args[0] === 'pr' && args[1] === 'create') return ((opened = true), '')
    if (args[0] === 'pr' && args[1] === 'view') {
      if (!opened) throw new Error('no pull requests found for branch')
      return JSON.stringify({ number: 7, url: 'https://github.com/me/shop/pull/7', state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], mergeCommit: null, mergedAt: null })
    }
    return ''
  }
  return Object.assign(gh, { calls })
}

const fakeAsk = async (prompt: string) => (prompt.startsWith('Name a git branch') ? 'footer-year' : 'Add a footer with the year\n\n- shows the year')
const typesOf = async (runId: string) => (await eventsSince(runId, 0)).map(e => e.type)
const autoShips = async (runId: string) => (await eventsSince(runId, 0)).filter(e => e.type === 'run.auto_ship').map(e => e.payload as Record<string, unknown>)
const statusOf = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status

test('kept, sent and opened, once each', async () => {
  const { runId, bare } = await approvedRun('github')
  const gh = fakeGh()
  const deps = { gh, ask: fakeAsk }
  expect(await autoKeep(runId, deps)).toEqual({ ok: true })
  expect(await autoSend(runId, deps)).toEqual({ ok: true })
  expect(await autoOpen(runId, deps)).toEqual({ ok: true })
  const types = (await typesOf(runId)).filter(t => ['run.kept', 'run.pushed', 'run.pr_opened'].includes(t))
  expect(types).toEqual(['run.kept', 'run.pushed', 'run.pr_opened'])
  expect((await autoShips(runId)).map(a => a.state)).toEqual(['started', 'opened'])
  const state = await deliveryState(runId)
  expect(state.branch).toMatch(/^ai\/footer-year-/)
  expect(git(bare, 'rev-parse', state.branch!)).toBe(state.commit)
  expect(git(bare, 'log', '-1', '--format=%s', state.branch!)).toBe('Add a footer with the year')
  expect(git(bare, 'branch', '--list', 'main')).not.toBe('') // origin held nothing: main went first, as it is
  // The pull request goes to origin's repository by name, never to whichever repository gh would pick itself.
  expect(gh.calls).toContainEqual(['pr', 'create', '--repo', 'ai-factory-test/never-real', '--base', 'main', '--head', state.branch, '--fill-first'])
  expect(gh.calls.filter(c => c[0] === 'pr').every(c => c[c.indexOf('--repo') + 1] === 'ai-factory-test/never-real')).toBe(true)
  expect(state.autoShip).toEqual({ state: 'opened', step: null, reason: null, message: null, at: expect.any(String) })
  expect(gh.calls.some(c => c.includes('merge'))).toBe(false)
})

test('each step is safe to run twice', async () => {
  const { runId } = await approvedRun('github')
  const gh = fakeGh()
  const deps = { gh, ask: fakeAsk }
  await autoKeep(runId, deps)
  await autoSend(runId, deps)
  await autoOpen(runId, deps)
  const before = (await eventsSince(runId, 0)).length
  expect(await autoKeep(runId, deps)).toEqual({ ok: true })
  expect(await autoSend(runId, deps)).toEqual({ ok: true })
  expect(await autoOpen(runId, deps)).toEqual({ ok: true })
  expect((await eventsSince(runId, 0)).length).toBe(before)
  expect(gh.calls.filter(c => c[1] === 'create')).toHaveLength(1)
})

test('a branch the person already kept and sent is not kept or sent again', async () => {
  const { runId } = await approvedRun('github')
  const { keepOnBranch, pushBranch } = await import('@/engine/delivery')
  await keepOnBranch(runId, { name: 'ai/my-footer' })
  await pushBranch(runId)
  const gh = fakeGh()
  expect(await autoKeep(runId, { gh, ask: fakeAsk })).toEqual({ ok: true })
  expect(await autoSend(runId, { gh })).toEqual({ ok: true })
  expect(await autoOpen(runId, { gh, ask: fakeAsk })).toEqual({ ok: true })
  const types = await typesOf(runId)
  expect(types.filter(t => t === 'run.kept')).toHaveLength(1)
  expect(types.filter(t => t === 'run.pushed')).toHaveLength(1)
  expect(types.filter(t => t === 'run.pr_opened')).toHaveLength(1)
  expect((await deliveryState(runId)).branch).toBe('ai/my-footer')
})

test('no origin: it is kept, nothing is sent, and the run is still completed', async () => {
  const { runId } = await approvedRun('none')
  expect(await autoKeep(runId, { ask: fakeAsk })).toEqual({ ok: true })
  expect(await autoSend(runId, { gh: fakeGh() })).toEqual({ ok: false })
  expect((await autoShips(runId)).at(-1)).toEqual({ state: 'stopped', step: 'send', reason: 'no_connection', message: strings.delivery.noRemote })
  const state = await deliveryState(runId)
  expect(state.kept).toBe(true)
  expect(state.pushed).toBe(false)
  expect(state.autoShip).toEqual({ state: 'stopped', step: 'send', reason: 'no_connection', message: strings.delivery.noRemote, at: expect.any(String) })
  expect(await statusOf(runId)).toBe('completed')
})

test('the test origin cannot reach any network host: without the stand-in for GitHub, git refuses to connect', async () => {
  const { dir } = await project('github')
  expect(() => execFileSync('git', ['-c', 'remote.origin.vcs=', 'ls-remote', 'origin'], { cwd: dir, stdio: 'pipe' })).toThrow()
})

describe('nothing is sent without the whole way to a pull request', () => {
  const sentNothing = async (origin: Origin, gh: Gh, message: string) => {
    const { runId, bare } = await approvedRun(origin)
    await autoKeep(runId, { gh, ask: fakeAsk })
    expect(await autoSend(runId, { gh })).toEqual({ ok: false })
    expect((await autoShips(runId)).at(-1)).toEqual({ state: 'stopped', step: 'send', reason: 'no_connection', message })
    expect(branchesIn(bare)).toBe('')
    const state = await deliveryState(runId)
    expect([state.kept, state.pushed]).toEqual([true, false])
    expect(await statusOf(runId)).toBe('completed')
  }

  test('an origin that is not on GitHub', async () => {
    const gh = fakeGh()
    await sentNothing('plain', gh, strings.ship.notGitHub)
    expect(gh.calls).toEqual([])
  })

  test('gh not installed', async () => {
    await sentNothing('github', fakeGh(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })), strings.ship.noGh)
  })

  test('gh not signed in', async () => {
    const gh = fakeGh('You are not logged into any GitHub hosts. To log in, run: gh auth login')
    await sentNothing('github', gh, strings.ship.notLoggedIn)
    expect(gh.calls).toEqual([['auth', 'status', '--hostname', 'github.com']])
  })

  test('an origin that reads from GitHub but sends somewhere else is judged by where it sends', async () => {
    const gh = fakeGh()
    const { runId, bare, dir } = await approvedRun('github')
    git(dir, 'config', 'remote.origin.pushurl', bare)
    await autoKeep(runId, { gh, ask: fakeAsk })
    expect(await autoSend(runId, { gh })).toEqual({ ok: false })
    expect((await autoShips(runId)).at(-1)).toMatchObject({ step: 'send', reason: 'no_connection', message: strings.ship.notGitHub })
    expect(branchesIn(bare)).toBe('')
    expect(gh.calls).toEqual([])
  })

  test('opening checks the whole way again before it sends anything, even when the send step was skipped', async () => {
    const { runId, bare } = await approvedRun('github')
    await autoKeep(runId, { ask: fakeAsk })
    const gh = fakeGh('You are not logged into any GitHub hosts. To log in, run: gh auth login')
    expect(await autoOpen(runId, { gh })).toEqual({ ok: false })
    expect((await autoShips(runId)).at(-1)).toMatchObject({ state: 'stopped', step: 'open', reason: 'no_connection', message: strings.ship.notLoggedIn })
    expect(branchesIn(bare)).toBe('')
    expect((await deliveryState(runId)).pushed).toBe(false)
  })
})

test('a kept branch named like the project\'s main branch is not sent on its own', async () => {
  const { runId, dir, bare } = await approvedRun('github')
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  const { keepOnBranch } = await import('@/engine/delivery')
  await keepOnBranch(runId, { name: 'trunk' })
  expect(await autoSend(runId, { gh: fakeGh() })).toEqual({ ok: false })
  expect((await autoShips(runId)).at(-1)).toEqual({ state: 'stopped', step: 'send', reason: 'failed', message: strings.delivery.auto.mainBranch })
  expect(branchesIn(bare)).toBe('')
})

test('a refused push is said, nothing is forced, and the change stays kept', async () => {
  const { runId } = await approvedRun('missing')
  await autoKeep(runId, { ask: fakeAsk })
  expect(await autoSend(runId, { gh: fakeGh() })).toEqual({ ok: false })
  const last = (await autoShips(runId)).at(-1)!
  expect(last).toMatchObject({ state: 'stopped', step: 'send', reason: 'failed' })
  expect(String(last.message)).toMatch(/^Git could not push the branch\./)
  expect(String(last.message).length).toBeLessThanOrEqual(300)
  expect((await deliveryState(runId)).kept).toBe(true)
  expect(await statusOf(runId)).toBe('completed')
})

describe('whether a change ships on its own', () => {
  test('only in "only what matters", without "stop for me"', async () => {
    const { runId } = await approvedRun('github')
    expect(await shouldShipOnItsOwn(runId, 'everything', false)).toBe(false)
    expect(await shouldShipOnItsOwn(runId, 'small_changes', false)).toBe(false)
    expect(await shouldShipOnItsOwn(runId, 'what_matters', true)).toBe(false)
    // The person's yes counts as a pass.
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(true)
  })

  test('not for a failed run', async () => {
    const { runId } = await approvedRun('github', builder('src/ui/footer/Footer.tsx', failing))
    expect(await statusOf(runId)).toBe('failed')
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })

  test('not for the demo', async () => {
    const { runId } = await approvedRun('github', createDemoProvider({ stepDelayMs: 0 }))
    expect(await statusOf(runId)).toBe('completed')
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })

  test('not again after it stopped', async () => {
    const { runId } = await approvedRun('none')
    await autoKeep(runId, { ask: fakeAsk })
    await autoSend(runId, { gh: fakeGh() })
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })

  test('not again after it opened', async () => {
    const { runId } = await approvedRun('github')
    const deps = { gh: fakeGh(), ask: fakeAsk }
    await autoKeep(runId, deps)
    await autoSend(runId, deps)
    await autoOpen(runId, deps)
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })

  test('not for a passed run that changed nothing: there is nothing to send', async () => {
    const quiet: AgentProvider = { ...builder(), async *execute(input) {
      if (input.blockKind === 'tests') yield { type: 'evidence', kind: 'test_run', data: passing }
      if (input.blockKind === 'review') {
        yield { type: 'done', summary: 'ok', source: 'provider', review: { verdict: 'ok', findings: [] } }
        return
      }
      yield { type: 'done', summary: 'ok', source: 'system' }
    } }
    const { runId } = await approvedRun('github', quiet)
    expect(await statusOf(runId)).toBe('completed')
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })
})

describe('when a step keeps failing until the run gives up', () => {
  test('a started send is ended where it got to, and the run stays completed', async () => {
    const { runId, bare } = await approvedRun('github')
    await autoKeep(runId, { ask: fakeAsk })
    // The send step threw something that is not a refusal, again and again, until Inngest gave up.
    await afterRunGaveUp(runId)
    expect((await autoShips(runId)).at(-1)).toEqual({ state: 'stopped', step: 'send', reason: 'failed', message: strings.run.internalFailure })
    expect(await statusOf(runId)).toBe('completed')
    expect(branchesIn(bare)).toBe('')
    // Once ended, giving up again adds nothing.
    const before = (await eventsSince(runId, 0)).length
    await afterRunGaveUp(runId)
    expect((await eventsSince(runId, 0)).length).toBe(before)
  })

  test('a keep that never finished is ended at the keep', async () => {
    const { runId } = await approvedRun('github')
    const { appendEvent } = await import('@/engine/events')
    await appendEvent({ runId, type: 'run.auto_ship', payload: { state: 'started', step: null, reason: null, message: null } })
    await afterRunGaveUp(runId)
    expect((await autoShips(runId)).at(-1)).toMatchObject({ state: 'stopped', step: 'keep', reason: 'failed' })
  })

  test('a run that failed before it completed gets no automatic-pull-request record, and stays failed', async () => {
    const { runId } = await approvedRun('github', builder('src/ui/footer/Footer.tsx', failing))
    await afterRunGaveUp(runId)
    expect(await autoShips(runId)).toEqual([])
    expect(await statusOf(runId)).toBe('failed')
  })

  test('a pull request recorded before the step failed is said to be open, not stopped', async () => {
    const { runId } = await approvedRun('github')
    const deps = { gh: fakeGh(), ask: fakeAsk }
    await autoKeep(runId, deps)
    await autoSend(runId, deps)
    const { openPullRequest } = await import('@/engine/ship')
    await openPullRequest(runId, deps.gh)
    // The open step then failed for good before it said "opened".
    await afterRunGaveUp(runId)
    expect((await autoShips(runId)).map(a => a.state)).toEqual(['started', 'opened'])
    expect(await statusOf(runId)).toBe('completed')
  })

  test('the second cleanup runs when the first throws, and each error is logged', async () => {
    const { runId } = await approvedRun('github')
    await autoKeep(runId, { ask: fakeAsk })
    // As if the run were still going, so failing it is tried, and the database refuses that one update.
    await db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId))
    await db.execute(sql.raw(`create function refuse_fail() returns trigger language plpgsql as $$ begin raise exception 'refused in the test'; end $$`))
    await db.execute(sql.raw(`create trigger refuse_fail before update on runs for each row when (new.status = 'failed' and old.id = '${runId}') execute function refuse_fail()`))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // The first cleanup's own error is what Inngest is given.
      await expect(afterRunGaveUp(runId)).rejects.toThrow(/update "runs"/)
      expect((await autoShips(runId)).at(-1)).toMatchObject({ state: 'stopped', step: 'send', reason: 'failed' })
      expect(logged).toHaveBeenCalledTimes(1)
      expect(String(logged.mock.calls[0]![0])).toContain('could not be marked as failed')
    } finally {
      logged.mockRestore()
      await db.execute(sql.raw('drop trigger refuse_fail on runs'))
      await db.execute(sql.raw('drop function refuse_fail()'))
    }
  })

  test('a run that was opened is left as it is', async () => {
    const { runId } = await approvedRun('github')
    const deps = { gh: fakeGh(), ask: fakeAsk }
    await autoKeep(runId, deps)
    await autoSend(runId, deps)
    await autoOpen(runId, deps)
    await afterRunGaveUp(runId)
    expect((await autoShips(runId)).map(a => a.state)).toEqual(['started', 'opened'])
    expect(await statusOf(runId)).toBe('completed')
  })
})

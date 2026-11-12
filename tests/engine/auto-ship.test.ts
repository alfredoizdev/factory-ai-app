import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, migrateDb } from '@/db/client'
import { runs } from '@/db/schema'
import type { AskMode } from '@/domain/ask-mode'
import { autoKeep, autoOpen, autoSend, shouldShipOnItsOwn } from '@/engine/auto-ship'
import { deliveryState } from '@/engine/delivery'
import { eventsSince } from '@/engine/events'
import { APPROVAL_DECIDED, PLAN_DECIDED } from '@/engine/inngest/client'
import { orchestrateRun, type StepApi } from '@/engine/inngest/execute-run'
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

// After a change passes, in "only what matters": kept on its branch, sent to GitHub and opened as a pull request, each
// on its own, each safe to run twice, and every missing piece or refusal said softly with the change still kept.
// `origin` is always a bare repository in a temporary folder, and `gh` is always a fake: nothing reaches GitHub.

beforeAll(() => migrateDb())
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

type Origin = 'bare' | 'missing' | 'none'
/** A project made the way the app makes one, on a real folder with one commit, and where its origin points. */
async function project(origin: Origin, askMode: AskMode = 'everything') {
  const dir = mkdtempSync(join(tmpdir(), 'factory-auto-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'me@example.com')
  git(dir, 'config', 'user.name', 'me')
  writeFileSync(join(dir, 'README.md'), 'shop\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'mine')
  let bare: string | null = null
  if (origin === 'bare') {
    bare = mkdtempSync(join(tmpdir(), 'factory-auto-origin-'))
    git(bare, 'init', '-q', '--bare', '-b', 'main')
    git(dir, 'remote', 'add', 'origin', bare)
  } else if (origin === 'missing') {
    git(dir, 'remote', 'add', 'origin', join(mkdtempSync(join(tmpdir(), 'factory-auto-gone-')), 'not-here.git'))
  }
  const { projectId, workflowId } = await createProject({ path: dir, name: 'Shop', testCommand: 'npm test', checks: [], askMode })
  return { dir, bare, projectId, workflowId }
}

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
function fakeGh(fail?: string): Gh & { calls: string[][] } {
  const calls: string[][] = []
  let opened = false
  const gh: Gh = async (args: string[]) => {
    calls.push(args)
    if (fail) throw new Error(fail)
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
  const { runId, bare } = await approvedRun('bare')
  const gh = fakeGh()
  const deps = { gh, ask: fakeAsk }
  expect(await autoKeep(runId, deps)).toEqual({ ok: true })
  expect(await autoSend(runId)).toEqual({ ok: true })
  expect(await autoOpen(runId, deps)).toEqual({ ok: true })
  const types = (await typesOf(runId)).filter(t => ['run.kept', 'run.pushed', 'run.pr_opened'].includes(t))
  expect(types).toEqual(['run.kept', 'run.pushed', 'run.pr_opened'])
  expect((await autoShips(runId)).map(a => a.state)).toEqual(['started', 'opened'])
  const state = await deliveryState(runId)
  expect(state.branch).toMatch(/^ai\/footer-year-/)
  expect(git(bare!, 'rev-parse', state.branch!)).toBe(state.commit)
  expect(git(bare!, 'log', '-1', '--format=%s', state.branch!)).toBe('Add a footer with the year')
  expect(git(bare!, 'branch', '--list', 'main')).toBe('') // their main was not sent
  expect(gh.calls).toContainEqual(['pr', 'create', '--base', 'main', '--head', state.branch, '--fill-first'])
  expect(state.autoShip).toEqual({ state: 'opened', step: null, reason: null, message: null })
  expect(gh.calls.some(c => c.includes('merge'))).toBe(false)
})

test('each step is safe to run twice', async () => {
  const { runId } = await approvedRun('bare')
  const gh = fakeGh()
  const deps = { gh, ask: fakeAsk }
  await autoKeep(runId, deps)
  await autoSend(runId)
  await autoOpen(runId, deps)
  const before = (await eventsSince(runId, 0)).length
  expect(await autoKeep(runId, deps)).toEqual({ ok: true })
  expect(await autoSend(runId)).toEqual({ ok: true })
  expect(await autoOpen(runId, deps)).toEqual({ ok: true })
  expect((await eventsSince(runId, 0)).length).toBe(before)
  expect(gh.calls.filter(c => c[1] === 'create')).toHaveLength(1)
})

test('a branch the person already kept and sent is not kept or sent again', async () => {
  const { runId } = await approvedRun('bare')
  const { keepOnBranch, pushBranch } = await import('@/engine/delivery')
  await keepOnBranch(runId, { name: 'ai/my-footer' })
  await pushBranch(runId)
  const gh = fakeGh()
  expect(await autoKeep(runId, { gh, ask: fakeAsk })).toEqual({ ok: true })
  expect(await autoSend(runId)).toEqual({ ok: true })
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
  expect(await autoSend(runId)).toEqual({ ok: false })
  expect((await autoShips(runId)).at(-1)).toEqual({ state: 'stopped', step: 'send', reason: 'no_connection', message: strings.delivery.noRemote })
  const state = await deliveryState(runId)
  expect(state.kept).toBe(true)
  expect(state.pushed).toBe(false)
  expect(state.autoShip).toEqual({ state: 'stopped', step: 'send', reason: 'no_connection', message: strings.delivery.noRemote })
  expect(await statusOf(runId)).toBe('completed')
})

test('gh not signed in is said, and the branch is still sent', async () => {
  const { runId } = await approvedRun('bare')
  const gh = fakeGh('To get started with GitHub CLI, please run:  gh auth login')
  await autoKeep(runId, { gh, ask: fakeAsk })
  await autoSend(runId)
  expect(await autoOpen(runId, { gh, ask: fakeAsk })).toEqual({ ok: false })
  expect((await autoShips(runId)).at(-1)).toEqual({ state: 'stopped', step: 'open', reason: 'no_connection', message: strings.ship.notLoggedIn })
  expect((await deliveryState(runId)).pushed).toBe(true)
  expect(await statusOf(runId)).toBe('completed')
})

test('a refused push is said, nothing is forced, and the change stays kept', async () => {
  const { runId } = await approvedRun('missing')
  await autoKeep(runId, { ask: fakeAsk })
  expect(await autoSend(runId)).toEqual({ ok: false })
  const last = (await autoShips(runId)).at(-1)!
  expect(last).toMatchObject({ state: 'stopped', step: 'send', reason: 'failed' })
  expect(String(last.message)).toMatch(/^Git could not push the branch\./)
  expect(String(last.message).length).toBeLessThanOrEqual(300)
  expect((await deliveryState(runId)).kept).toBe(true)
  expect(await statusOf(runId)).toBe('completed')
})

describe('whether a change ships on its own', () => {
  test('only in "only what matters", without "stop for me"', async () => {
    const { runId } = await approvedRun('bare')
    expect(await shouldShipOnItsOwn(runId, 'everything', false)).toBe(false)
    expect(await shouldShipOnItsOwn(runId, 'small_changes', false)).toBe(false)
    expect(await shouldShipOnItsOwn(runId, 'what_matters', true)).toBe(false)
    // The person's yes counts as a pass.
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(true)
  })

  test('not for a failed run', async () => {
    const { runId } = await approvedRun('bare', builder('src/ui/footer/Footer.tsx', failing))
    expect(await statusOf(runId)).toBe('failed')
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })

  test('not for the demo', async () => {
    const { runId } = await approvedRun('bare', createDemoProvider({ stepDelayMs: 0 }))
    expect(await statusOf(runId)).toBe('completed')
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })

  test('not again after it stopped', async () => {
    const { runId } = await approvedRun('none')
    await autoKeep(runId, { ask: fakeAsk })
    await autoSend(runId)
    expect(await shouldShipOnItsOwn(runId, 'what_matters', false)).toBe(false)
  })
})

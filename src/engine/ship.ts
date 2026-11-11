import { execFile } from 'node:child_process'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, projects, runs } from '@/db/schema'
import { defaultBranch } from '@/engine/branches'
import { DeliveryError, deliveryState, pushBranch } from '@/engine/delivery'
import { appendEventSync } from '@/engine/events'
import { clip, redact } from '@/engine/redact'
import { strings } from '@/ui/strings'

// Shipping an approved change through GitHub: push its branch, open a pull request, wait for whatever checks that
// repository runs, and — only when the person says so — squash-merge it into the main branch. Nothing here assumes a
// particular CI or host: the checks and the deploy are whatever GitHub reports for this repository, and when it
// reports none, that is said plainly. Everything goes through the `gh` CLI with the person's own login.

export type Gh = (args: string[], cwd: string) => Promise<string>

const defaultGh: Gh = (args, cwd) =>
  new Promise((resolve, reject) =>
    execFile('gh', args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error(String(stderr || err.message)), { code: (err as NodeJS.ErrnoException).code })) : resolve(String(stdout)),
    ),
  )

export type CheckState = 'pending' | 'passed' | 'failed' | 'neutral'
export type Check = { name: string; state: CheckState; url: string | null }
export type ShipState = {
  /** The pull request, once opened. */
  pr: { number: number; url: string; state: 'open' | 'merged' | 'closed'; conflicts: boolean } | null
  /** What GitHub runs on the pull request: any CI, any host. Empty: the repository runs none. */
  checks: Check[]
  /** All checks finished, none failed (true with no checks at all): the merge button may be offered. */
  checksDone: boolean
  checksFailed: boolean
  /** After the merge: what reported on the merged commit (a deploy, CI on main). Empty: nothing reported. */
  deploy: Check[]
  mergedAt: string | null
  /** The person said: everything is ready, but do not merge yet. Never true once merged or closed. */
  onHold: boolean
}

export class ShipError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message)
    this.name = 'ShipError'
  }
}

type Rollup = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string | null; state?: string; detailsUrl?: string; targetUrl?: string }

/** One check from GitHub's rollup, whatever produced it: a check run (Actions and apps) or a commit status (hosts). */
export function checkOf(c: Rollup): Check {
  const name = c.name ?? c.context ?? 'check'
  const url = c.detailsUrl ?? c.targetUrl ?? null
  if (c.__typename === 'StatusContext' || c.state !== undefined) {
    const s = (c.state ?? '').toUpperCase()
    return { name, url, state: s === 'SUCCESS' ? 'passed' : s === 'FAILURE' || s === 'ERROR' ? 'failed' : 'pending' }
  }
  if ((c.status ?? '').toUpperCase() !== 'COMPLETED') return { name, url, state: 'pending' }
  const done = (c.conclusion ?? '').toUpperCase()
  return {
    name,
    url,
    state: done === 'SUCCESS' ? 'passed' : done === 'NEUTRAL' || done === 'SKIPPED' ? 'neutral' : 'failed',
  }
}

function recordOf(runId: string, type: 'run.pr_opened' | 'run.merged' | 'run.on_hold'): Record<string, unknown> | null {
  const row = db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, type))).orderBy(desc(events.sequence)).get()
  return row ? { ...(JSON.parse(row.payloadJson) as Record<string, unknown>), at: row.createdAt } : null
}

/** Right after a pull request opens, GitHub may not have listed its checks yet: no checks then is not "none". */
export const CHECKS_GRACE_MS = 60_000

function repoOf(runId: string): { repo: string; branch: string } {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run) throw new ShipError(strings.errors.runNotFound, 404)
  const repo = db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, run.projectId)).get()?.repoPath
  if (!repo) throw new ShipError(strings.run.noRepository)
  const state = deliveryState(runId)
  if (!state.kept || !state.branch) throw new ShipError(strings.delivery.keepFirst)
  return { repo, branch: state.branch }
}

/** gh's own failure, said in a person's words: missing, not logged in, not a GitHub repository, or what it said. */
function ghFailure(e: unknown): ShipError {
  const err = e as { code?: string; message?: string }
  if (err.code === 'ENOENT') return new ShipError(strings.ship.noGh)
  const said = redact(String(err.message ?? '')).replace(/[a-z]+:\/\/[^\s]*@/gi, '')
  if (/auth login|not logged|authentication/i.test(said)) return new ShipError(strings.ship.notLoggedIn)
  if (/no git remotes|not a github|none of the git remotes/i.test(said)) return new ShipError(strings.ship.notGitHub)
  return new ShipError(strings.ship.ghSaid(clip(said.trim().split('\n').filter(Boolean).slice(-2).join(' '), 300)))
}

/**
 * Pushes the kept branch and opens a pull request for it into the main branch, titled and described by its commit.
 * Once: a pull request already open for the branch is reused.
 */
export async function openPullRequest(runId: string, gh: Gh = defaultGh): Promise<ShipState> {
  const { repo, branch } = repoOf(runId)
  if (!recordOf(runId, 'run.pr_opened')) {
    try {
      await pushBranch(runId)
    } catch (e) {
      throw e instanceof DeliveryError ? new ShipError(e.message) : e
    }
    const base = defaultBranch(repo) ?? 'main'
    let pr: { number: number; url: string }
    try {
      pr = JSON.parse(await gh(['pr', 'view', branch, '--json', 'number,url,state'], repo)) as { number: number; url: string }
      if ((pr as { state?: string }).state !== 'OPEN') throw new Error('not open')
    } catch {
      try {
        await gh(['pr', 'create', '--base', base, '--head', branch, '--fill-first'], repo)
        pr = JSON.parse(await gh(['pr', 'view', branch, '--json', 'number,url'], repo)) as { number: number; url: string }
      } catch (e) {
        throw ghFailure(e)
      }
    }
    db.transaction(tx => void appendEventSync({ runId, type: 'run.pr_opened', payload: { number: pr.number, url: pr.url, base } }, tx), { behavior: 'immediate' })
  }
  return shipState(runId, gh)
}

/**
 * A branch sent to GitHub before the app opened pull requests itself may have one, opened from GitHub's own page.
 * If GitHub has a pull request for the branch, it is recorded as this run's, so the card shows where it really stands
 * (often: already merged). Nothing is created; without one, or without gh, nothing changes.
 */
async function adoptPullRequest(runId: string, gh: Gh): Promise<Record<string, unknown> | null> {
  const state = deliveryState(runId)
  if (!state.kept || !state.pushed || !state.branch) return null
  const { repo, branch } = repoOf(runId)
  let found: { number: number; url: string; baseRefName?: string }[]
  try {
    found = JSON.parse(await gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,baseRefName', '--limit', '1'], repo))
  } catch {
    return null
  }
  const pr = found[0]
  if (!pr || typeof pr.number !== 'number') return null
  db.transaction(tx => void appendEventSync({ runId, type: 'run.pr_opened', payload: { number: pr.number, url: pr.url, base: pr.baseRefName ?? null, adopted: true } }, tx), { behavior: 'immediate' })
  return recordOf(runId, 'run.pr_opened')
}

/** Where the pull request stands: its checks while open, what reported on the merged commit once merged. */
export async function shipState(runId: string, gh: Gh = defaultGh): Promise<ShipState> {
  const opened = recordOf(runId, 'run.pr_opened') ?? (await adoptPullRequest(runId, gh))
  const empty: ShipState = { pr: null, checks: [], checksDone: false, checksFailed: false, deploy: [], mergedAt: null, onHold: false }
  if (!opened) return empty
  const { repo } = repoOf(runId)
  let view: { number: number; url: string; state: string; mergeable: string; statusCheckRollup: Rollup[]; mergeCommit: { oid: string } | null; mergedAt: string | null }
  try {
    view = JSON.parse(await gh(['pr', 'view', String(opened.number), '--json', 'number,url,state,mergeable,statusCheckRollup,mergeCommit,mergedAt'], repo))
  } catch (e) {
    throw ghFailure(e)
  }
  const checks = (view.statusCheckRollup ?? []).map(checkOf)
  const justOpened = Date.now() - Date.parse(String(opened.at)) < CHECKS_GRACE_MS
  const state = view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open'
  let deploy: Check[] = []
  if (state === 'merged' && view.mergeCommit?.oid) {
    try {
      const commit = JSON.parse(await gh(['api', `repos/{owner}/{repo}/commits/${view.mergeCommit.oid}/status`], repo)) as { statuses?: { context: string; state: string; target_url: string | null }[] }
      const runsOf = JSON.parse(await gh(['api', `repos/{owner}/{repo}/commits/${view.mergeCommit.oid}/check-runs`], repo)) as { check_runs?: { name: string; status: string; conclusion: string | null; details_url: string | null }[] }
      deploy = [
        ...(commit.statuses ?? []).map(s => checkOf({ __typename: 'StatusContext', context: s.context, state: s.state, targetUrl: s.target_url ?? undefined })),
        ...(runsOf.check_runs ?? []).map(r => checkOf({ __typename: 'CheckRun', name: r.name, status: r.status, conclusion: r.conclusion, detailsUrl: r.details_url ?? undefined })),
      ]
    } catch {
      deploy = []
    }
  }
  return {
    pr: { number: view.number, url: view.url, state, conflicts: view.mergeable === 'CONFLICTING' },
    checks,
    checksDone: checks.every(c => c.state !== 'pending') && (checks.length > 0 || state !== 'open' || !justOpened),
    checksFailed: checks.some(c => c.state === 'failed'),
    deploy,
    mergedAt: view.mergedAt ?? null,
    onHold: state === 'open' && isOnHold(runId),
  }
}

/** Whether the person's last word on this run's pull request was "hold", and it was not merged since. */
export function isOnHold(runId: string): boolean {
  if (recordOf(runId, 'run.merged')) return false
  return recordOf(runId, 'run.on_hold')?.held === true
}

/**
 * Puts the open pull request on hold, or takes it off: everything stays ready, nothing is merged, and the task list
 * says it is waiting on the person. Only a label the person sets; merging is still their own click.
 */
export async function setHold(runId: string, held: boolean, gh: Gh = defaultGh): Promise<ShipState> {
  const current = await shipState(runId, gh)
  if (!current.pr) throw new ShipError(strings.ship.openFirst)
  if (current.pr.state !== 'open') throw new ShipError(current.pr.state === 'merged' ? strings.ship.merged : strings.ship.closed)
  if (current.onHold !== held) {
    db.transaction(tx => void appendEventSync({ runId, type: 'run.on_hold', payload: { held } }, tx), { behavior: 'immediate' })
  }
  return { ...current, onHold: held }
}

/**
 * Squash-merges the pull request into the main branch, which is what puts the change live wherever the repository
 * deploys from main. Only the person asks for this, only once its checks are done and none failed, and never over a
 * conflict. The branch is left in place.
 */
export async function mergePullRequest(runId: string, gh: Gh = defaultGh): Promise<ShipState> {
  const current = await shipState(runId, gh)
  if (!current.pr) throw new ShipError(strings.ship.openFirst)
  if (current.pr.state === 'merged') return current
  if (current.pr.state === 'closed') throw new ShipError(strings.ship.closed)
  if (current.pr.conflicts) throw new ShipError(strings.ship.conflicts)
  if (!current.checksDone) throw new ShipError(strings.ship.checksRunning)
  if (current.checksFailed) throw new ShipError(strings.ship.checksFailed)
  const { repo } = repoOf(runId)
  try {
    await gh(['pr', 'merge', String(current.pr.number), '--squash'], repo)
  } catch (e) {
    throw ghFailure(e)
  }
  db.transaction(tx => void appendEventSync({ runId, type: 'run.merged', payload: { number: current.pr!.number } }, tx), { behavior: 'immediate' })
  return shipState(runId, gh)
}

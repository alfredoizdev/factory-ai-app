import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, projects, runs } from '@/db/schema'
import { appendEventSync } from '@/engine/events'
import { clip, redact } from '@/engine/redact'
import { branchFromWords, fallbackWords, type CommitMessage } from '@/engine/branch-name'
import { branchNameFor } from '@/engine/worktree'
import { strings } from '@/ui/strings'
import { projectHere, setLocal } from '@/engine/machine'
import { elsewhere, runPlace } from '@/engine/machine'
import { serialized } from '@/engine/serial'
import { humanCheckPassedBy } from '@/engine/passed-check'

// Bringing an approved change into the person's own project. Two things, both local, nothing pushed anywhere:
// the change is committed on the run's own branch (factory/<run>), so it is kept and can be merged or pushed later;
// and the same change is applied to the person's checkout, uncommitted, for them to look at and commit themselves.
// Their checkout must be clean: their own unsaved work is never mixed with the agent's.

export type Delivery = {
  /** True once a person approved this run and it finished: only then can it be brought over. */
  eligible: boolean
  /** Who opened the human check: the person, or the app on its own. Null while nobody has. */
  passedBy: 'person' | 'app' | null
  /** Committed on its own branch in the person's repository. */
  kept: boolean
  /** Also applied to the person's checkout, uncommitted. */
  delivered: boolean
  branch: string | null
  commit: string | null
  files: string[]
  appliedTo: string | null
  /** The branch the person's project is on right now, read live; null when it is not a branch (or unreadable). */
  current: string | null
  /** Where "Back" would return the project to: the branch it was on before this run switched it. */
  returnTo: string | null
  /** Sent to the project's origin. */
  pushed: boolean
  /** Where to open a pull request for it, when origin is on GitHub. */
  pullRequestUrl: string | null
  /** Whether the project has a remote called origin, read live: without one the change can be saved but not sent. Null when unknown (the project is on another computer). */
  hasRemote?: boolean | null
  /** False when the run's working copy is on another computer: the actions that need it are not offered here. */
  here: boolean
  /** The name of the computer it is on, when known. */
  machine: string | null
  /** Kept, sent and opened as a pull request on its own after it passed: how far that went. Null when it was not tried. */
  autoShip: AutoShip | null
}

/** The latest word of the steps that keep, send and open a change on their own. The values are stored: never reword them. */
export type AutoShip = { state: 'started' | 'opened' | 'stopped'; step: 'keep' | 'send' | 'open' | null; reason: 'no_connection' | 'failed' | null; message: string | null }

export class DeliveryError extends Error {
  /** `no_connection`: the project is not connected to GitHub (no origin), so there is nowhere to send it. */
  constructor(message: string, readonly status: 400 | 404 | 409, readonly kind?: 'no_connection') {
    super(message)
    this.name = 'DeliveryError'
  }
}

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()

async function approvedAndFinished(runId: string) {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return null
  const passedBy = await humanCheckPassedBy(runId)
  return { run, passedBy, eligible: run.status === 'completed' && passedBy !== null && !!run.worktreePath && !!run.baseCommit }
}

type Record_ = { branch?: string; commit?: string; files?: string[]; appliedTo?: string; from?: string; pullRequestUrl?: string | null }

/** The latest record of this kind for this run, if there was one. A keep or a delivery happens once; a switch may repeat. */
async function recordOf(runId: string, type: 'run.kept' | 'run.delivered' | 'run.switched' | 'run.pushed'): Promise<Record_ | null> {
  const row = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, type))).orderBy(desc(events.sequence)))[0]
  return row ? (JSON.parse(row.payloadJson) as Record_) : null
}

async function repoOf(projectId: string): Promise<string | null> {
  return (await projectHere(projectId))?.repoPath ?? null
}

/** The branch a checkout is on, or null when it is detached or cannot be read. */
function currentBranch(repo: string | null): string | null {
  if (!repo) return null
  try {
    return git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null
  } catch {
    return null
  }
}
/** The address of the repository's origin as git reads it, or null when it has none. */
export function originUrl(repo: string): string | null {
  try {
    return git(repo, ['remote', 'get-url', 'origin']).trim() || null
  } catch {
    return null
  }
}
/** Whether the repository has a remote called origin; null when there is no repository here to ask. */
function hasOrigin(repo: string | null): boolean | null {
  return repo ? originUrl(repo) !== null : null
}
const deliveredRecord = (runId: string) => recordOf(runId, 'run.delivered')

export async function deliveryState(runId: string): Promise<Delivery> {
  const found = (await approvedAndFinished(runId))
  if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
  const kept = (await recordOf(runId, 'run.kept'))
  const done = await deliveredRecord(runId)
  const pushedRecord = (await recordOf(runId, 'run.pushed'))
  const place = await runPlace(runId)
  const repo = await repoOf(found.run.projectId)
  return {
    hasRemote: place.here ? hasOrigin(repo) : null,
    here: place.here,
    machine: place.machine,
    eligible: found.eligible,
    passedBy: found.passedBy,
    kept: !!kept,
    delivered: !!done,
    branch: kept?.branch ?? found.run.branch,
    commit: done?.commit ?? kept?.commit ?? null,
    files: done?.files ?? kept?.files ?? [],
    appliedTo: done?.appliedTo ?? null,
    current: currentBranch(repo),
    returnTo: (await recordOf(runId, 'run.switched'))?.from ?? null,
    pushed: pushedRecord !== null && pushedRecord.branch === (kept?.branch ?? found.run.branch),
    pullRequestUrl: pushedRecord?.pullRequestUrl ?? null,
    autoShip: await autoShipRecord(runId),
  }
}

/**
 * The latest word of the automatic keep, send and open, as recorded. A stop stays the latest word after the person
 * finishes that step by hand: the card weighs it against `kept`, `pushed` and the pull request.
 */
export async function autoShipRecord(runId: string): Promise<AutoShip | null> {
  const row = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.auto_ship'))).orderBy(desc(events.sequence)))[0]
  if (!row) return null
  const p = JSON.parse(row.payloadJson) as Partial<AutoShip>
  return { state: p.state ?? 'started', step: p.step ?? null, reason: p.reason ?? null, message: p.message ?? null }
}

/**
 * Commits whatever the agent left uncommitted in the run's worktree, on the run's own branch, and returns the commit
 * the branch now points at. Used to keep an approved change before it is brought over or built upon.
 */
export function keepCommit(
  run: { id: string; request: string; worktreePath: string | null },
  described?: CommitMessage | null,
  passedBy: 'person' | 'app' = 'person',
): string {
  const wt = run.worktreePath!
  git(wt, ['add', '-A'])
  if (git(wt, ['diff', '--cached', '--name-only']) !== '') {
    // Says what changed when a description was written from the diff; otherwise the request is the best summary there is.
    // Either way the request and the provenance are kept in the body.
    const asked = run.request.replace(/\s+/g, ' ').trim()
    const provenance =
      passedBy === 'app'
        ? `Made by an agent in AI Factory, run ${run.id}. ${strings.delivery.passedOnItsOwn}`
        : `Made by an agent in AI Factory, run ${run.id}, and approved by a person.`
    const message = described
      ? `${described.subject}\n\n${described.body ? `${described.body}\n\n` : ''}Asked for: ${clip(asked, 500)}\n\n${provenance}`
      : `${clip(asked, 72)}\n\n${provenance}`
    git(wt, ['-c', 'user.name=AI Factory', '-c', 'user.email=ai-factory@localhost', 'commit', '-q', '--no-verify', '-m', message])
  }
  return git(wt, ['rev-parse', 'HEAD'])
}

/**
 * Saves what a run that did not finish left in its worktree, on its own branch, so another run can pick it up.
 * Unlike keepCommit this is nobody's approved change, and its message says so.
 */
export function unfinishedCommit(run: { id: string; request: string; worktreePath: string | null }): string {
  const wt = run.worktreePath!
  git(wt, ['add', '-A'])
  if (git(wt, ['diff', '--cached', '--name-only']) !== '') {
    const asked = run.request.replace(/\s+/g, ' ').trim()
    const message = `Unfinished: ${clip(asked, 60)}\n\nLeft by an agent in AI Factory, run ${run.id}, which stopped before a person approved it.`
    git(wt, ['-c', 'user.name=AI Factory', '-c', 'user.email=ai-factory@localhost', 'commit', '-q', '--no-verify', '-m', message])
  }
  return git(wt, ['rev-parse', 'HEAD'])
}

/** True once this run's change was brought into the project. */
export async function wasDelivered(runId: string): Promise<boolean> {
  return (await deliveredRecord(runId)) !== null
}

/** A branch name a person typed: plain characters only, and one git itself accepts. */
const OWN_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
export function validBranchName(name: string): boolean {
  if (!OWN_NAME.test(name) || name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.lock') || name.endsWith('.')) return false
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** The files the agent changed in its copy, committed or not: what a branch name should describe. */
export async function changedFiles(runId: string): Promise<string[]> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  const wt = run?.worktreePath
  if (!run || !wt) return []
  try {
    const from = run.deliveryBase ?? run.baseCommit!
    const tracked = git(wt, ['diff', '--name-only', from]).split('\n')
    const untracked = git(wt, ['ls-files', '--others', '--exclude-standard']).split('\n')
    return [...new Set([...tracked, ...untracked].filter(Boolean))].sort()
  } catch {
    return []
  }
}

/** The change the agent left, committed or not, as one diff (new files included): what a commit message describes. */
export async function pendingDiff(runId: string): Promise<string> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  const wt = run?.worktreePath
  if (!run || !wt) return ''
  try {
    const from = run.deliveryBase ?? run.baseCommit!
    const tracked = git(wt, ['diff', from])
    const added = git(wt, ['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      .filter(Boolean)
      .map(f => `new file: ${f}`)
    return redact([tracked, ...added].join('\n'))
  } catch {
    return ''
  }
}

/** The run's request, for naming its branch. */
export async function requestOf(runId: string): Promise<string | null> {
  return (await db.select().from(runs).where(eq(runs.id, runId)))[0]?.request ?? null
}

/**
 * Keeps the approved change on its own branch in the person's repository: one commit, on a branch with a name a person
 * can read. That name is the one they typed, when they typed one; otherwise the automatic name the run started with
 * is replaced by `fallbackName`, or by the request's own meaningful words. Their checkout and branches are not
 * touched. Once.
 */
export type KeepOptions = { name?: string | null; fallbackName?: string | null; message?: CommitMessage | null }

export async function keepOnBranch(runId: string, options: KeepOptions = {}): Promise<Delivery> {
  return serialized(runId, async () => {
    const away = await elsewhere(runId)
    if (away) throw new DeliveryError(away, 409)
    const found = (await approvedAndFinished(runId))
    if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
    if (!found.eligible) throw new DeliveryError(strings.delivery.notEligible, 409)
    if ((await recordOf(runId, 'run.kept'))) return deliveryState(runId)
    const { run } = found
    const wt = run.worktreePath!
    const own = options.name?.trim() || null
    if (own !== null && !validBranchName(own)) throw new DeliveryError(strings.delivery.badBranchName, 400)
    let branch = run.branch ?? git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const exists = (name: string) => git(wt, ['branch', '--list', name]) !== ''
    if (own !== null && own !== branch && exists(own)) throw new DeliveryError(strings.delivery.branchExists(own), 409)
    const commit = keepCommit(run, options.message, found.passedBy ?? 'person')
    const from = run.deliveryBase ?? run.baseCommit!
    const files = git(wt, ['diff', '--name-only', from, commit]).split('\n').filter(Boolean)
    if (files.length === 0) throw new DeliveryError(strings.delivery.nothing, 409)
    // Only a name the app made up is replaced; a branch the person named is theirs.
    const automatic = branch.startsWith('factory/') || branch === branchNameFor(run.id, run.request)
    const wanted =
      own ?? (automatic ? (options.fallbackName ?? branchFromWords(run.id, fallbackWords(run.request) ?? 'change')) : branch)
    if (wanted !== branch && (own !== null || !exists(wanted))) {
      git(wt, ['branch', '-m', wanted])
      await db.update(runs).set({ branch: wanted }).where(eq(runs.id, run.id))
      branch = wanted
    }
    await db.transaction(
      async tx => {
        await appendEventSync({ runId, type: 'run.kept', payload: { branch, commit, files } }, tx)
      },
    )
    return deliveryState(runId)
  })
}

/**
 * Applies the approved change, uncommitted, to the person's checkout — on whatever branch they are on — after keeping
 * it on its own branch. Once. Refused, with nothing changed, when their checkout has unsaved work.
 */
export async function deliverToProject(runId: string, options: KeepOptions = {}): Promise<Delivery> {
  return serialized(runId, async () => {
    const away = await elsewhere(runId)
    if (away) throw new DeliveryError(away, 409)
    const found = (await approvedAndFinished(runId))
    if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
    if (!found.eligible) throw new DeliveryError(strings.delivery.notEligible, 409)
    if (await deliveredRecord(runId)) return deliveryState(runId)
    const project = await projectHere(found.run.projectId)
    const repo = project?.repoPath
    if (!repo) throw new DeliveryError(strings.run.noRepository, 409)

    // Their unsaved work is theirs: nothing is applied over it, and nothing else happens either.
    if (git(repo, ['status', '--porcelain']) !== '') throw new DeliveryError(strings.delivery.dirty, 409)

    // 1. Keep it on its own branch first, so the change exists as a commit before it is copied anywhere.
    const kept = (await keepOnBranch(runId, options))
    const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]!
    const wt = run.worktreePath!
    // A follow-up whose parent was never brought over starts from the parent's base, so both changes travel together.
    const from = run.deliveryBase ?? run.baseCommit!
    const commit = kept.commit!
    const files = kept.files

    // 2. Bring it over: the whole change since the base, applied to their checkout, unstaged. Checked first, so a
    // change that no longer fits (they edited the same lines since) is refused whole, never half-applied.
    const patch = git(wt, ['diff', '--binary', from, commit])
    const dir = mkdtempSync(join(tmpdir(), 'factory-delivery-'))
    const file = join(dir, 'change.patch')
    try {
      writeFileSync(file, patch.endsWith('\n') ? patch : `${patch}\n`)
      try {
        git(repo, ['apply', '--check', '--whitespace=nowarn', file])
      } catch {
        throw new DeliveryError(strings.delivery.conflict(run.branch ?? ''), 409)
      }
      git(repo, ['apply', '--whitespace=nowarn', file])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    await db.transaction(
      async tx => {
        await appendEventSync({ runId, type: 'run.delivered', payload: { branch: kept.branch, commit, files, appliedTo: repo } }, tx)
      },
    )
    return deliveryState(runId)
  })
}

/** Moves the person's checkout to a branch, refusing — with nothing changed — over unsaved work. */
function checkoutIn(repo: string, branch: string): void {
  if (git(repo, ['status', '--porcelain', '--untracked-files=no']) !== '') throw new DeliveryError(strings.delivery.dirty, 409)
  try {
    git(repo, ['checkout', '-q', branch])
  } catch {
    // git refuses before touching anything, e.g. when an untracked file of theirs would be overwritten.
    throw new DeliveryError(strings.delivery.switchFailed(branch), 409)
  }
}

/**
 * Puts the person's project on the run's kept branch, so they see the change in their own folder and dev server.
 * Remembers the branch it was on, for switchBack. Refused while the change is not kept yet, or over unsaved work.
 */
export async function switchToBranch(runId: string): Promise<Delivery> {
  return serialized(runId, async () => {
    const away = await elsewhere(runId)
    if (away) throw new DeliveryError(away, 409)
    const found = (await approvedAndFinished(runId))
    if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
    const kept = (await recordOf(runId, 'run.kept'))
    if (!kept?.branch) throw new DeliveryError(strings.delivery.keepFirst, 409)
    const repo = (await repoOf(found.run.projectId))
    if (!repo) throw new DeliveryError(strings.run.noRepository, 409)
    const from = currentBranch(repo)
    if (from === kept.branch) return deliveryState(runId)
    if (!from) throw new DeliveryError(strings.delivery.notOnBranch, 409)
    if (git(repo, ['status', '--porcelain', '--untracked-files=no']) !== '') throw new DeliveryError(strings.delivery.dirty, 409)
    // A branch can be checked out in one place only, and the agent's copy still holds it: let go of it there first.
    // The commit stays where it is; the agent's copy just stops being "on" the branch.
    const wt = found.run.worktreePath
    if (wt) {
      try {
        git(wt, ['checkout', '-q', '--detach'])
      } catch {
        // The agent's copy is gone or already detached: nothing holds the branch.
      }
    }
    checkoutIn(repo, kept.branch)
    await db.transaction(async tx => void (await appendEventSync({ runId, type: 'run.switched', payload: { branch: kept.branch, from } }, tx)))
    return deliveryState(runId)
  })
}

/** Returns the person's project to the branch it was on before switchToBranch. Refused over unsaved work. */
export async function switchBack(runId: string): Promise<Delivery> {
  return serialized(runId, async () => {
    const away = await elsewhere(runId)
    if (away) throw new DeliveryError(away, 409)
    const found = (await approvedAndFinished(runId))
    if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
    const switched = (await recordOf(runId, 'run.switched'))
    if (!switched?.from) throw new DeliveryError(strings.delivery.neverSwitched, 409)
    const repo = (await repoOf(found.run.projectId))
    if (!repo) throw new DeliveryError(strings.run.noRepository, 409)
    if (currentBranch(repo) !== switched.from) {
      checkoutIn(repo, switched.from)
      await db.transaction(async tx => void (await appendEventSync({ runId, type: 'run.switched_back', payload: { branch: switched.from } }, tx)))
    }
    return deliveryState(runId)
  })
}

/**
 * The page where GitHub opens a pull request for a branch, from the remote's address. Only owner and repository are
 * read from it, so a token written into the remote URL can never reach the page. Null for anything not on github.com.
 */
export function githubPullUrl(remote: string, branch: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/new/${branch}` : null
}

const gitAsync = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    // Never waits for a password prompt: the person's saved credentials work, or the push fails and says so.
    execFile('git', args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message))) : resolve(String(stdout).trim()),
    )
  })

/**
 * Sends the kept branch — that branch only, never forced — to the project's origin, with the person's own git
 * credentials. Their other branches are not sent. Refused before the change is kept, or with no origin.
 */
export async function pushBranch(runId: string): Promise<Delivery> {
  return serialized(runId, async () => {
    const away = await elsewhere(runId)
    if (away) throw new DeliveryError(away, 409)
    const found = (await approvedAndFinished(runId))
    if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
    const kept = (await recordOf(runId, 'run.kept'))
    if (!kept?.branch) throw new DeliveryError(strings.delivery.keepFirst, 409)
    const branch = kept.branch
    const repo = (await repoOf(found.run.projectId))
    if (!repo) throw new DeliveryError(strings.run.noRepository, 409)
    const remote = originUrl(repo)
    if (remote === null) throw new DeliveryError(strings.delivery.noRemote, 409, 'no_connection')
    try {
      await gitAsync(repo, ['push', '--porcelain', 'origin', `refs/heads/${branch}:refs/heads/${branch}`])
    } catch (e) {
      // git's own words, minus anything secret and any address that could carry a token.
      const said = redact(String((e as Error).message)).replace(/[a-z]+:\/\/[^\s]*@/gi, '').trim().split('\n').filter(Boolean).slice(-2).join(' ')
      throw new DeliveryError(strings.delivery.pushFailed(clip(said, 240)), 409)
    }
    try {
      git(repo, ['branch', '--set-upstream-to', `origin/${branch}`, branch])
    } catch {
      // Upstream tracking is a convenience; the push itself succeeded.
    }
    const pullRequestUrl = githubPullUrl(remote, branch)
    // Sending the same branch again (opening its pull request pushes first) is said once.
    const before = await recordOf(runId, 'run.pushed')
    if (before?.branch !== branch || (before.pullRequestUrl ?? null) !== pullRequestUrl) {
      await db.transaction(async tx => void (await appendEventSync({ runId, type: 'run.pushed', payload: { branch, pullRequestUrl } }, tx)))
    }
    return deliveryState(runId)
  })
}

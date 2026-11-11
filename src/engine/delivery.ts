import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, events, projects, runs } from '@/db/schema'
import { appendEventSync } from '@/engine/events'
import { clip } from '@/engine/redact'
import { branchNameFor } from '@/engine/worktree'
import { strings } from '@/ui/strings'

// Bringing an approved change into the person's own project. Two things, both local, nothing pushed anywhere:
// the change is committed on the run's own branch (factory/<run>), so it is kept and can be merged or pushed later;
// and the same change is applied to the person's checkout, uncommitted, for them to look at and commit themselves.
// Their checkout must be clean: their own unsaved work is never mixed with the agent's.

export type Delivery = {
  /** True once a person approved this run and it finished: only then can it be brought over. */
  eligible: boolean
  /** Committed on its own branch in the person's repository. */
  kept: boolean
  /** Also applied to the person's checkout, uncommitted. */
  delivered: boolean
  branch: string | null
  commit: string | null
  files: string[]
  appliedTo: string | null
}

export class DeliveryError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'DeliveryError'
  }
}

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()

function approvedAndFinished(runId: string) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run) return null
  const approved = db.select().from(approvals).where(and(eq(approvals.runId, runId), eq(approvals.decision, 'approved'))).get()
  return { run, eligible: run.status === 'completed' && !!approved && !!run.worktreePath && !!run.baseCommit }
}

type Record_ = { branch?: string; commit?: string; files?: string[]; appliedTo?: string }

/** The record of an earlier keep or delivery of this run, if there was one. Each happens once. */
function recordOf(runId: string, type: 'run.kept' | 'run.delivered'): Record_ | null {
  const row = db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, type))).get()
  return row ? (JSON.parse(row.payloadJson) as Record_) : null
}
const deliveredRecord = (runId: string) => recordOf(runId, 'run.delivered')

export function deliveryState(runId: string): Delivery {
  const found = approvedAndFinished(runId)
  if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
  const kept = recordOf(runId, 'run.kept')
  const done = deliveredRecord(runId)
  return {
    eligible: found.eligible,
    kept: !!kept,
    delivered: !!done,
    branch: kept?.branch ?? found.run.branch,
    commit: done?.commit ?? kept?.commit ?? null,
    files: done?.files ?? kept?.files ?? [],
    appliedTo: done?.appliedTo ?? null,
  }
}

/**
 * Commits whatever the agent left uncommitted in the run's worktree, on the run's own branch, and returns the commit
 * the branch now points at. Used to keep an approved change before it is brought over or built upon.
 */
export function keepCommit(run: { id: string; request: string; worktreePath: string | null }): string {
  const wt = run.worktreePath!
  git(wt, ['add', '-A'])
  if (git(wt, ['diff', '--cached', '--name-only']) !== '') {
    const message = `${clip(run.request.replace(/\s+/g, ' ').trim(), 72)}\n\nMade by an agent in AI Factory, run ${run.id}, and approved by a person.`
    git(wt, ['-c', 'user.name=AI Factory', '-c', 'user.email=ai-factory@localhost', 'commit', '-q', '--no-verify', '-m', message])
  }
  return git(wt, ['rev-parse', 'HEAD'])
}

/** True once this run's change was brought into the project. */
export function wasDelivered(runId: string): boolean {
  return deliveredRecord(runId) !== null
}

/**
 * Keeps the approved change on its own branch in the person's repository: one commit, on a branch named after the
 * request. Their checkout and their branches are not touched. Once; a run from before readable names gets one now.
 */
export function keepOnBranch(runId: string): Delivery {
  const found = approvedAndFinished(runId)
  if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
  if (!found.eligible) throw new DeliveryError(strings.delivery.notEligible, 409)
  if (recordOf(runId, 'run.kept')) return deliveryState(runId)
  const { run } = found
  const wt = run.worktreePath!
  const commit = keepCommit(run)
  const from = run.deliveryBase ?? run.baseCommit!
  const files = git(wt, ['diff', '--name-only', from, commit]).split('\n').filter(Boolean)
  if (files.length === 0) throw new DeliveryError(strings.delivery.nothing, 409)
  let branch = run.branch ?? git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch.startsWith('factory/')) {
    const readable = branchNameFor(run.id, run.request)
    git(wt, ['branch', '-m', readable])
    db.update(runs).set({ branch: readable }).where(eq(runs.id, run.id)).run()
    branch = readable
  }
  db.transaction(
    tx => {
      appendEventSync({ runId, type: 'run.kept', payload: { branch, commit, files } }, tx)
    },
    { behavior: 'immediate' },
  )
  return deliveryState(runId)
}

/**
 * Applies the approved change, uncommitted, to the person's checkout — on whatever branch they are on — after keeping
 * it on its own branch. Once. Refused, with nothing changed, when their checkout has unsaved work.
 */
export function deliverToProject(runId: string): Delivery {
  const found = approvedAndFinished(runId)
  if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
  if (!found.eligible) throw new DeliveryError(strings.delivery.notEligible, 409)
  if (deliveredRecord(runId)) return deliveryState(runId)
  const project = db.select().from(projects).where(eq(projects.id, found.run.projectId)).get()
  const repo = project?.repoPath
  if (!repo) throw new DeliveryError(strings.run.noRepository, 409)

  // Their unsaved work is theirs: nothing is applied over it, and nothing else happens either.
  if (git(repo, ['status', '--porcelain']) !== '') throw new DeliveryError(strings.delivery.dirty, 409)

  // 1. Keep it on its own branch first, so the change exists as a commit before it is copied anywhere.
  const kept = keepOnBranch(runId)
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
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

  db.transaction(
    tx => {
      appendEventSync({ runId, type: 'run.delivered', payload: { branch: kept.branch, commit, files, appliedTo: repo } }, tx)
    },
    { behavior: 'immediate' },
  )
  return deliveryState(runId)
}

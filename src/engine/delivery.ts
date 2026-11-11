import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, events, projects, runs } from '@/db/schema'
import { appendEventSync } from '@/engine/events'
import { clip } from '@/engine/redact'
import { strings } from '@/ui/strings'

// Bringing an approved change into the person's own project. Two things, both local, nothing pushed anywhere:
// the change is committed on the run's own branch (factory/<run>), so it is kept and can be merged or pushed later;
// and the same change is applied to the person's checkout, uncommitted, for them to look at and commit themselves.
// Their checkout must be clean: their own unsaved work is never mixed with the agent's.

export type Delivery = {
  /** True once a person approved this run and it finished: only then can it be brought over. */
  eligible: boolean
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

/** The record of an earlier delivery of this run, if there was one. Delivery happens once. */
function deliveredRecord(runId: string): { commit?: string; files?: string[]; appliedTo?: string } | null {
  const row = db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.delivered'))).get()
  return row ? (JSON.parse(row.payloadJson) as { commit?: string; files?: string[]; appliedTo?: string }) : null
}

export function deliveryState(runId: string): Delivery {
  const found = approvedAndFinished(runId)
  if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
  const done = deliveredRecord(runId)
  return {
    eligible: found.eligible,
    delivered: !!done,
    branch: found.run.branch,
    commit: done?.commit ?? null,
    files: done?.files ?? [],
    appliedTo: done?.appliedTo ?? null,
  }
}

/** Commits the approved change on the run's branch and applies it, uncommitted, to the person's checkout. Once. */
export function deliverToProject(runId: string): Delivery {
  const found = approvedAndFinished(runId)
  if (!found) throw new DeliveryError(strings.errors.runNotFound, 404)
  if (!found.eligible) throw new DeliveryError(strings.delivery.notEligible, 409)
  if (deliveredRecord(runId)) return deliveryState(runId)
  const { run } = found
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get()
  const repo = project?.repoPath
  if (!repo) throw new DeliveryError(strings.run.noRepository, 409)
  const wt = run.worktreePath!

  // Their unsaved work is theirs: nothing is applied over it.
  if (git(repo, ['status', '--porcelain']) !== '') throw new DeliveryError(strings.delivery.dirty, 409)

  // 1. Keep it: one commit on the run's own branch, in the agent's worktree. Their branches are not touched.
  git(wt, ['add', '-A'])
  const files = git(wt, ['diff', '--cached', '--name-only', run.baseCommit!]).split('\n').filter(Boolean)
  if (files.length === 0) throw new DeliveryError(strings.delivery.nothing, 409)
  const pending = git(wt, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
  if (pending.length > 0) {
    const message = `${clip(run.request.replace(/\s+/g, ' ').trim(), 72)}\n\nMade by an agent in AI Factory, run ${run.id}, and approved by a person.`
    git(wt, ['-c', 'user.name=AI Factory', '-c', 'user.email=ai-factory@localhost', 'commit', '-q', '--no-verify', '-m', message])
  }
  const commit = git(wt, ['rev-parse', 'HEAD'])

  // 2. Bring it over: the whole change since the base, applied to their checkout, unstaged. Checked first, so a
  // change that no longer fits (they edited the same lines since) is refused whole, never half-applied.
  const patch = git(wt, ['diff', '--binary', run.baseCommit!, commit])
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
      appendEventSync({ runId, type: 'run.delivered', payload: { branch: run.branch, commit, files, appliedTo: repo } }, tx)
    },
    { behavior: 'immediate' },
  )
  return deliveryState(runId)
}

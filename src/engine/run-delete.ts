import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { attachments, projects, runs } from '@/db/schema'
import { ATTACHMENT_DIR } from '@/engine/attachments'
import { stopPreview } from '@/engine/preview'
import { SNAP_ROOT } from '@/engine/snapshots'
import { DEFAULT_WORKTREE_ROOT } from '@/engine/worktree'
import { strings } from '@/ui/strings'

// Deleting a task removes what the app keeps about it: its record (every event, step, measurement and decision goes
// with it) and the agent's working copy. What it produced in the person's project, its saved branch, is theirs and
// stays. A task still working or waiting for their decision is not deleted: it is cancelled or decided first.

export class RunDeleteError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'RunDeleteError'
  }
}

const LIVE = new Set(['queued', 'running', 'waiting_approval'])

/** True when `path` is strictly inside `root`: nothing outside the app's own folders is ever removed. */
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`)
}

export function deleteRun(runId: string, options: { worktreeRoot?: string; attachmentDir?: string; snapshotDir?: string } = {}): void {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run) throw new RunDeleteError(strings.errors.runNotFound, 404)
  if (LIVE.has(run.status)) throw new RunDeleteError(strings.history.stillLive, 409)
  const repo = db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, run.projectId)).get()?.repoPath ?? null
  const files = db.select({ path: attachments.path }).from(attachments).where(eq(attachments.runId, runId)).all().map(a => a.path)

  stopPreview(runId)
  db.delete(runs).where(eq(runs.id, runId)).run() // its events, nodes, evidence, decisions and attachment rows go with it

  const root = options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT
  const wt = run.worktreePath
  if (wt && inside(root, wt) && existsSync(wt)) {
    try {
      if (repo) execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo, stdio: 'ignore' })
    } catch {
      // Not a worktree git knows any more: the folder is removed below.
    }
    rmSync(wt, { recursive: true, force: true })
    if (repo) {
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' })
      } catch {
        // Pruning is tidying only.
      }
    }
  }
  const dir = options.attachmentDir ?? ATTACHMENT_DIR
  for (const file of files) if (inside(dir, file)) rmSync(file, { force: true })
  // Its before and after pictures go too. The run id is a ULID, so the folder is always inside the pictures folder.
  if (/^[0-9A-Z]{26}$/i.test(runId)) rmSync(join(options.snapshotDir ?? SNAP_ROOT, runId), { recursive: true, force: true })
}

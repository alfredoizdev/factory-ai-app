import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// One worktree per run (design §6), on its own branch off the repository's HEAD. The person's checkout is never
// touched: no checkout, no stash, no reset happens in it. Nothing here deletes a worktree; pruning is an explicit
// action the design leaves to the person.

export type RunWorkspace = { path: string; branch: string; baseCommit: string }

/** Where worktrees live: inside the app's own ignored data folder, never inside the person's repository. */
export const DEFAULT_WORKTREE_ROOT = join(process.cwd(), '.factory', 'worktrees')

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function createRunWorktree(repoPath: string, runId: string, root: string = DEFAULT_WORKTREE_ROOT): RunWorkspace {
  const branch = `factory/${runId.toLowerCase()}`
  const path = join(root, runId)
  // A replay of the same step after a crash finds the worktree it already made.
  if (existsSync(path)) {
    return { path, branch: git(path, ['rev-parse', '--abbrev-ref', 'HEAD']), baseCommit: git(path, ['merge-base', 'HEAD', branch]) }
  }
  const baseCommit = git(repoPath, ['rev-parse', '--verify', 'HEAD'])
  mkdirSync(root, { recursive: true })
  git(repoPath, ['worktree', 'add', '-q', '-b', branch, path, baseCommit])
  return { path, branch, baseCommit }
}

import { execFile, execFileSync } from 'node:child_process'

// Which branch a fresh task starts from. The agent works in its own copy, so a new task never needs the person's
// folder to be on any particular branch: it starts from the project's main branch unless they choose another.

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const tryGit = (cwd: string, args: string[]): string | null => {
  try {
    return git(cwd, args) || null
  } catch {
    return null
  }
}

/** A plain local branch name: nothing git could read as an option, a range or a revision expression. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

/** The commit a local branch points at, or null when there is no such branch. */
export function branchCommit(repo: string, branch: string): string | null {
  if (!PLAIN.test(branch) || branch.includes('..')) return null
  return tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
}

/** The project's main branch: what origin calls its default, else main, else master, else the one it is on. */
export function defaultBranch(repo: string): string | null {
  const fromOrigin = tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '')
  for (const name of [fromOrigin, 'main', 'master']) {
    if (name && branchCommit(repo, name)) return name
  }
  return tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

/**
 * Where a task on `branch` should start: the newest of the local branch and the same branch on origin. Merged pull
 * requests land on origin first, so a local main nobody pulled would start the task on stale code and its change would
 * conflict with what is already merged. Origin is fetched first, with the person's own git login and never a prompt;
 * when it cannot be reached, or the local branch has commits origin lacks, the local branch is used as it is.
 */
export async function freshestStart(repo: string, branch: string): Promise<{ commit: string; fromOrigin: boolean } | null> {
  const local = branchCommit(repo, branch)
  if (!local) return null
  if (!tryGit(repo, ['remote', 'get-url', 'origin'])) return { commit: local, fromOrigin: false }
  await new Promise<void>(resolve =>
    execFile('git', ['fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: repo, timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, () => resolve()),
  )
  const remote = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`])
  if (!remote || remote === local) return { commit: local, fromOrigin: false }
  // Origin is ahead (the local branch is part of its history): start there. Otherwise keep the person's own commits.
  try {
    git(repo, ['merge-base', '--is-ancestor', local, remote])
    return { commit: remote, fromOrigin: true }
  } catch {
    return { commit: local, fromOrigin: false }
  }
}

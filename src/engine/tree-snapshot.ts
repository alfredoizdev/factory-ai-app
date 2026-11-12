import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

// A snapshot of the task's folder taken before a fix, so a fix can be checked against it and taken back. It is a git
// tree object: tracked and untracked files that are not ignored. It is made with a temporary index file outside the
// folder, so the person's own index, HEAD, branches and stash are never touched. Ignored files (node_modules, build
// output) are not in it and are never deleted by a restore. Every git call uses an argument list, never a shell.

/** How many times one problem is fixed before it is given up on. */
export const MAX_FIX_ATTEMPTS = 2

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function checkId(id: string, what: string): void {
  if (typeof id !== 'string' || !OBJECT_ID.test(id)) throw new Error(`Not a git object id: ${what}`)
}

/** The environment for git here: nothing inherited may point it at another repository or index, and no hook or monitor of the person's may run. */
function gitEnv(indexFile?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[k]
  return { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) }
}

function run(workdir: string, args: string[], indexFile?: string, input?: string): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: workdir,
    env: gitEnv(indexFile),
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  })
}

/** Refuses a folder that is not itself the top of a working copy: a plain folder inside some other repository must not snapshot that one. */
function checkRoot(workdir: string): void {
  const top = run(workdir, ['rev-parse', '--show-toplevel']).trim()
  if (realpathSync(top) !== realpathSync(workdir)) throw new Error('The folder is not a working copy of its own')
}

/** Runs `fn` with an index file that lives in a temporary folder, and removes the folder afterwards. */
function withTempIndex<T>(fn: (indexFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'factory-index-'))
  try {
    return fn(join(dir, 'index'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A git tree id of the tracked and untracked files that are not ignored, as they are now. The real index is not touched. */
export function snapshotTree(workdir: string): string {
  checkRoot(workdir)
  return withTempIndex(index => {
    // Start from what HEAD tracks, so a tracked file that happens to match .gitignore is still in the snapshot; a new repository has no HEAD yet.
    let hasHead = true
    try {
      run(workdir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
    } catch {
      hasHead = false
    }
    if (hasHead) run(workdir, ['read-tree', 'HEAD'], index)
    run(workdir, ['add', '-A', '--', '.'], index)
    return run(workdir, ['write-tree'], index).trim()
  })
}

type Change = { status: string; path: string }

/** What differs between two trees (or a commit and a tree): git's status letter and the path, no renames. */
function diff(workdir: string, from: string, to: string): Change[] {
  const parts = run(workdir, ['diff-tree', '-r', '-z', '--name-status', '--no-renames', from, to]).split('\0')
  const out: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i]!, path: parts[i + 1]! })
  return out
}

/** The paths that differ between a commit (or tree) and a tree, sorted. */
export function changedBetween(workdir: string, from: string, tree: string): string[] {
  checkId(from, 'from')
  checkId(tree, 'tree')
  return diff(workdir, from, tree).map(c => c.path).sort()
}

/** The paths whose contents differ between the snapshot and the folder now, sorted. */
export function changedSince(workdir: string, tree: string): string[] {
  checkId(tree, 'tree')
  return changedBetween(workdir, tree, snapshotTree(workdir))
}

const insideFolder = (path: string): boolean => path !== '' && !path.startsWith('/') && path.split('/').every(seg => seg !== '' && seg !== '..' && seg !== '.git')

/** Removes the folders left empty by a removed file, up to (not including) the working copy itself. */
function pruneEmptyFolders(root: string, from: string): void {
  for (let dir = dirname(from); dir !== root && dir.startsWith(`${root}${sep}`); dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length > 0) return
      rmdirSync(dir)
    } catch {
      return
    }
  }
}

/**
 * Makes the folder's contents equal the snapshot: changed files are put back, deleted files are recreated, files added
 * since are removed. Ignored files are left alone and so is the real index.
 */
export function restoreTree(workdir: string, tree: string): void {
  checkId(tree, 'tree')
  checkRoot(workdir)
  const changes = diff(workdir, tree, snapshotTree(workdir))
  // In the diff from the snapshot to now: "A" was added since (remove it), "D" is gone now (put it back), anything else was edited.
  const added = changes.filter(c => c.status === 'A')
  const back = changes.filter(c => c.status !== 'A')
  for (const c of [...added, ...back]) if (!insideFolder(c.path)) throw new Error('A path outside the working copy')
  for (const c of added) {
    const full = join(workdir, c.path)
    try {
      lstatSync(full)
    } catch {
      continue
    }
    rmSync(full, { recursive: true, force: true })
    pruneEmptyFolders(workdir, full)
  }
  if (back.length === 0) return
  withTempIndex(index => {
    run(workdir, ['read-tree', tree], index)
    run(workdir, ['checkout-index', '-f', '-z', '--stdin'], index, back.map(c => `${c.path}\0`).join(''))
  })
}

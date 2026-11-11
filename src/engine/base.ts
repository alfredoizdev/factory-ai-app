import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { defaultBranch, freshestStart } from '@/engine/branches'
import { installDependencies, type InstallResult } from '@/engine/install'
import { clip, redact } from '@/engine/redact'

// The prepared base: once per project, a copy of its main branch with the dependencies installed. A task's working
// copy then gets those dependencies by copy (on macOS a copy-on-write clone, near instant) instead of installing them
// again — as long as its lockfile is the one the base was installed from. Anything else installs for itself.

export const BASE_ROOT = join(process.cwd(), '.factory', 'bases')
const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'] as const

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A fingerprint of what decides the installed dependencies: the lockfile, or package.json without one. */
export function lockHashOf(dir: string): string | null {
  for (const f of [...LOCKFILES, 'package.json']) {
    const p = join(dir, f)
    if (existsSync(p)) return `${f}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`
  }
  return null
}

/** The same fingerprint for a commit, read from git without checking it out. */
export function lockHashAt(repo: string, commit: string): string | null {
  for (const f of [...LOCKFILES, 'package.json']) {
    try {
      const content = execFileSync('git', ['show', `${commit}:${f}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
      return `${f}:${createHash('sha256').update(content).digest('hex')}`
    } catch {
      // not in this commit
    }
  }
  return null
}

/** Every node_modules folder in a tree that is not itself inside one (the root's, and each workspace package's). */
export function nodeModulesDirs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.name === 'node_modules') out.push(relative(root, path))
      else walk(path)
    }
  }
  walk(root)
  return out.sort()
}

export const basePathOf = (projectId: string, root = BASE_ROOT) => join(root, projectId)

function setBase(projectId: string, fields: Partial<typeof projects.$inferInsert>): void {
  db.update(projects).set({ ...fields, baseUpdatedAt: new Date().toISOString() }).where(eq(projects.id, projectId)).run()
}

const inFlight = new Set<string>()

/**
 * (Re)builds the project's prepared base from the newest main branch: a detached worktree, dependencies installed.
 * One at a time per project; a second call while one runs is a no-op. Never throws: the outcome is on the project.
 */
export async function prepareBase(
  projectId: string,
  deps: { install?: (dir: string) => Promise<InstallResult | null>; root?: string } = {},
): Promise<void> {
  if (inFlight.has(projectId)) return
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project?.repoPath) return
  inFlight.add(projectId)
  const repo = project.repoPath
  const path = basePathOf(projectId, deps.root)
  try {
    setBase(projectId, { baseStatus: 'installing', baseMessage: null })
    const main = defaultBranch(repo)
    const start = main ? await freshestStart(repo, main) : null
    const commit = start?.commit ?? git(repo, ['rev-parse', 'HEAD'])
    if (existsSync(path)) {
      try {
        git(repo, ['worktree', 'remove', '--force', path])
      } catch {
        rmSync(path, { recursive: true, force: true })
      }
    }
    mkdirSync(dirname(path), { recursive: true })
    git(repo, ['worktree', 'prune'])
    git(repo, ['worktree', 'add', '--detach', '-q', path, commit])
    const result = await (deps.install ?? installDependencies)(path)
    if (result && !result.ok) {
      setBase(projectId, { baseStatus: 'failed', baseCommit: commit, baseLockHash: null, baseMessage: clip(redact(result.outputTail).trim().split('\n').slice(-2).join(' '), 300) })
      return
    }
    setBase(projectId, { baseStatus: 'ready', baseCommit: commit, baseLockHash: lockHashOf(path), baseMessage: null })
  } catch (e) {
    setBase(projectId, { baseStatus: 'failed', baseMessage: clip(redact(e instanceof Error ? e.message : String(e)), 300) })
  } finally {
    inFlight.delete(projectId)
  }
}

export type BaseCopy = { copied: true; ms: number } | { copied: false; reason: 'no-base' | 'different-lockfile' | 'copy-failed' }

/** Gives a task's working copy the base's installed dependencies, when its lockfile is the base's. */
export function copyBaseInto(projectId: string, workdir: string, root = BASE_ROOT): BaseCopy {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  const base = basePathOf(projectId, root)
  if (project?.baseStatus !== 'ready' || !project.baseLockHash || !existsSync(base)) return { copied: false, reason: 'no-base' }
  if (lockHashOf(workdir) !== project.baseLockHash) return { copied: false, reason: 'different-lockfile' }
  const started = Date.now()
  try {
    for (const dir of nodeModulesDirs(base)) {
      const target = join(workdir, dir)
      if (existsSync(target)) continue
      mkdirSync(dirname(target), { recursive: true })
      // -c: a copy-on-write clone on APFS, near instant and sharing disk until written; plain copy elsewhere.
      try {
        execFileSync('cp', ['-cR', join(base, dir), target], { stdio: 'ignore' })
      } catch {
        execFileSync('cp', ['-R', join(base, dir), target], { stdio: 'ignore' })
      }
    }
    return { copied: true, ms: Date.now() - started }
  } catch {
    return { copied: false, reason: 'copy-failed' }
  }
}

/** True when the base was installed from a different lockfile than the one at `commit`: it should be rebuilt. */
export function baseIsStale(projectId: string, commit: string): boolean {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project?.repoPath || project.baseStatus !== 'ready') return false
  const at = lockHashAt(project.repoPath, commit)
  return at !== null && at !== project.baseLockHash
}

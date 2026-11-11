import { defaultBranch } from '@/engine/branches'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { detectTestCommand } from '@/engine/test-runner'
import { strings } from '@/ui/strings'

// One project = one local repository (design §7). A path is only stored once it is shown to be a repository root
// with at least one commit, because a worktree is made from it and an agent then works there unattended.

export class ProjectSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectSettingsError'
  }
}

export type ProjectSettings = {
  projectId: string
  repoPath: string | null
  testCommand: string | null
  autoApproveLowRisk: boolean
  /** The branch the repository is on right now, read live: a fresh run starts from it. Null when detached or unknown. */
  currentBranch: string | null
  /** The project's main branch, where a new task starts unless the person picks another. */
  defaultBranch: string | null
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function getProjectSettings(projectId: string): ProjectSettings {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) throw new ProjectSettingsError(strings.settings.noProject)
  return { projectId, repoPath: row.repoPath, testCommand: row.testCommand, autoApproveLowRisk: row.autoApproveLowRisk, currentBranch: branchOf(row.repoPath), defaultBranch: mainOf(row.repoPath) }
}

function mainOf(repo: string | null): string | null {
  if (!repo) return null
  try {
    return defaultBranch(repo)
  } catch {
    return null
  }
}

function branchOf(repo: string | null): string | null {
  if (!repo) return null
  try {
    return git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null
  } catch {
    return null
  }
}

function validRepoRoot(path: string): string {
  if (!isAbsolute(path)) throw new ProjectSettingsError(strings.settings.notAbsolute)
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new ProjectSettingsError(strings.settings.missing)
  const real = realpathSync(path)
  let top: string
  try {
    top = realpathSync(git(real, ['rev-parse', '--show-toplevel']))
  } catch {
    throw new ProjectSettingsError(strings.settings.notRepo)
  }
  if (top !== real) throw new ProjectSettingsError(strings.settings.notRoot)
  try {
    git(real, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    throw new ProjectSettingsError(strings.settings.noCommits)
  }
  return real
}

export function setProjectRepo(projectId: string, path: string): { repoPath: string; testCommand: string | null } {
  const current = getProjectSettings(projectId)
  const repoPath = validRepoRoot(path.trim())
  // A command the person chose is kept; the detected one is only a suggestion for an empty field.
  const testCommand = current.testCommand ?? detectTestCommand(repoPath)
  db.update(projects).set({ repoPath, testCommand }).where(eq(projects.id, projectId)).run()
  return { repoPath, testCommand }
}

/** The person's choice to let measured low-risk changes pass the human check on their own. */
export function setAutoApproveLowRisk(projectId: string, on: boolean): void {
  getProjectSettings(projectId)
  db.update(projects).set({ autoApproveLowRisk: on }).where(eq(projects.id, projectId)).run()
}

export function setTestCommand(projectId: string, command: string | null): void {
  getProjectSettings(projectId)
  const value = command?.trim() ? command.trim() : null
  db.update(projects).set({ testCommand: value }).where(eq(projects.id, projectId)).run()
}

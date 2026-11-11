import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, migrateDb } from '@/db/client'
import { projects, workflowVersions } from '@/db/schema'
import { baseIsStale, copyBaseInto, lockHashOf, nodeModulesDirs, prepareBase } from '@/engine/base'
import { createProject, listProjects } from '@/engine/projects'
import { ProjectSettingsError } from '@/engine/project-settings'

beforeAll(() => migrateDb())
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-proj-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'vitest run', lint: 'eslint' } }))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lock: 1\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'me@example.com')
  git(dir, 'config', 'user.name', 'me')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

// An "install" that writes a node_modules marker, at the root and in a workspace package.
const fakeInstall = async (dir: string) => {
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(dir, 'packages', 'ui', 'node_modules'), { recursive: true })
  return { command: 'pnpm install', ok: true, durationMs: 5, outputTail: '' }
}

test('a folder becomes a project with its own published flow, and a Tests block per extra check', async () => {
  const dir = repo()
  const { projectId, workflowId } = await createProject({ path: dir, name: 'Shop', testCommand: 'pnpm test', checks: [{ label: 'Lint', command: 'pnpm lint' }] })
  const listed = listProjects().find(p => p.projectId === projectId)!
  expect(listed).toMatchObject({ name: 'Shop', repoPath: realpathSync(dir), workflowId, baseStatus: 'none' })
  const version = db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).get()!
  const lint = (JSON.parse(version.graphJson) as { blocks: { kind: string; label: string; config: Record<string, unknown> }[] }).blocks.find(b => b.label === 'Lint')!
  expect(lint).toMatchObject({ kind: 'tests', config: { testCommand: 'pnpm lint' } })
  await expect(createProject({ path: dir, name: 'Again', testCommand: null, checks: [] })).rejects.toBeInstanceOf(ProjectSettingsError)
})

test('the prepared base installs once, and a task copy with the same lockfile gets its dependencies by copy', async () => {
  const dir = repo()
  const root = mkdtempSync(join(tmpdir(), 'factory-bases-'))
  const { projectId } = await createProject({ path: dir, name: 'Shop', testCommand: null, checks: [] })
  await prepareBase(projectId, { install: fakeInstall, root })
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()!
  expect(project).toMatchObject({ baseStatus: 'ready', baseCommit: git(dir, 'rev-parse', 'main') })
  expect(nodeModulesDirs(join(root, projectId))).toEqual(['node_modules', 'packages/ui/node_modules'])

  // A task's copy of the same commit: copied, root and workspace node_modules both.
  const task = mkdtempSync(join(tmpdir(), 'factory-task-'))
  writeFileSync(join(task, 'pnpm-lock.yaml'), 'lock: 1\n')
  const copied = copyBaseInto(projectId, task, root)
  expect(copied.copied).toBe(true)
  expect(readFileSync(join(task, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  expect(existsSync(join(task, 'packages', 'ui', 'node_modules'))).toBe(true)

  // A different lockfile installs for itself.
  const other = mkdtempSync(join(tmpdir(), 'factory-task-'))
  writeFileSync(join(other, 'pnpm-lock.yaml'), 'lock: 2\n')
  expect(copyBaseInto(projectId, other, root)).toEqual({ copied: false, reason: 'different-lockfile' })
})

test('a base built from an older lockfile is stale once main changes it', async () => {
  const dir = repo()
  const root = mkdtempSync(join(tmpdir(), 'factory-bases-'))
  const { projectId } = await createProject({ path: dir, name: 'Shop', testCommand: null, checks: [] })
  await prepareBase(projectId, { install: fakeInstall, root })
  expect(baseIsStale(projectId, git(dir, 'rev-parse', 'main'))).toBe(false)
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lock: 2\n')
  git(dir, 'commit', '-qam', 'bump')
  expect(baseIsStale(projectId, git(dir, 'rev-parse', 'main'))).toBe(true)
})

test('a failed install leaves the base failed, with what it said', async () => {
  const dir = repo()
  const root = mkdtempSync(join(tmpdir(), 'factory-bases-'))
  const { projectId } = await createProject({ path: dir, name: 'Shop', testCommand: null, checks: [] })
  await prepareBase(projectId, { install: async () => ({ command: 'pnpm install', ok: false, durationMs: 1, outputTail: 'ERR_PNPM_FETCH_404 left-pad' }), root })
  expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toMatchObject({ baseStatus: 'failed', baseMessage: expect.stringContaining('ERR_PNPM_FETCH_404') })
})

test('no package.json, no lock fingerprint', () => {
  expect(lockHashOf(mkdtempSync(join(tmpdir(), 'factory-empty-')))).toBeNull()
})

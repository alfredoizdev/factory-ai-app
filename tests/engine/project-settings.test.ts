import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { getProjectSettings, ProjectSettingsError, setProjectRepo, setTestCommand } from '@/engine/project-settings'
import { createRun, publishVersion, RepoNotSetError, saveDraft } from '@/engine/run'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

async function newProject(): Promise<string> {
  const id = ulid()
  await db.insert(projects).values({ id, projectId: id, name: 'p', createdAt: now() })
  return id
}
function repo(options: { commit?: boolean; tests?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-settings-')))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  if (options.tests) writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
  if (options.commit !== false) {
    writeFileSync(join(dir, 'a.txt'), 'x')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
  }
  return dir
}
const refusal = async (fn: () => unknown) => {
  try {
    await fn()
  } catch (e) {
    if (e instanceof ProjectSettingsError) return e.message
    throw e
  }
  throw new Error('expected a refusal')
}

test('a valid repository is stored, and the obvious test command is suggested', async () => {
  const id = (await newProject())
  const dir = repo({ tests: true })
  expect((await setProjectRepo(id, dir))).toEqual({ repoPath: dir, testCommand: 'npm test' })
  expect((await getProjectSettings(id))).toMatchObject({ projectId: id, repoPath: dir, testCommand: 'npm test', autoApproveLowRisk: false })
})

test('a test command the person already set is never overwritten by the suggestion', async () => {
  const id = (await newProject())
  await setTestCommand(id, 'make check')
  expect((await setProjectRepo(id, repo({ tests: true }))).testCommand).toBe('make check')
})

test.each([
  ['a relative path', () => 'some/dir', strings.settings.notAbsolute],
  ['a path that does not exist', () => '/definitely/not/here/factory', strings.settings.missing],
  ['a folder that is not a repository', () => realpathSync(mkdtempSync(join(tmpdir(), 'plain-'))), strings.settings.notRepo],
  ['a repository with no commits', () => repo({ commit: false }), strings.settings.noCommits],
  ['a folder inside a repository rather than its root', () => {
    const dir = repo()
    mkdirSync(join(dir, 'sub'))
    return join(dir, 'sub')
  }, strings.settings.notRoot],
])('%s is refused with its own sentence and nothing is stored', async (_, path, sentence) => {
  const id = (await newProject())
  expect(await refusal(() => setProjectRepo(id, path()))).toBe(sentence)
  expect((await getProjectSettings(id)).repoPath).toBeNull()
})

test('a test command can be set and cleared; blank means none', async () => {
  const id = (await newProject())
  await setTestCommand(id, '  npm run test:unit  ')
  expect((await getProjectSettings(id)).testCommand).toBe('npm run test:unit')
  await setTestCommand(id, '   ')
  expect((await getProjectSettings(id)).testCommand).toBeNull()
})

async function publishedWorkflow(projectId: string): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  return workflowId
}

test('a Claude run without a repository is refused and no run is created', async () => {
  const id = (await newProject())
  const workflowId = await publishedWorkflow(id)
  await expect(createRun({ workflowId, request: 'r', providerId: 'claude' })).rejects.toBeInstanceOf(RepoNotSetError)
  expect((await db.select().from(runs).where(eq(runs.workflowId, workflowId)))).toEqual([])
})

test('the demo stays the default, and Claude is recorded when chosen with a repository', async () => {
  const id = (await newProject())
  await setProjectRepo(id, repo())
  const workflowId = await publishedWorkflow(id)
  const demo = await createRun({ workflowId, request: 'r' })
  const real = await createRun({ workflowId, request: 'r', providerId: 'claude' })
  const provider = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.providerId
  expect((await provider(demo.runId))).toBe('demo')
  expect((await provider(real.runId))).toBe('claude')
})

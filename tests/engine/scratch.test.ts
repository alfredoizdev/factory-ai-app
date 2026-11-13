import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, migrateDb } from '@/db/client'
import { workflows } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { rulesFor } from '@/engine/memory'
import { analyzeProject, foldersOf } from '@/engine/project-setup'
import { createProject } from '@/engine/projects'
import { listRegister } from '@/engine/register'
import { checkNewFolder, cleanGitHubUrl, startFromScratch } from '@/engine/scratch'
import { POST } from '@/app/api/projects/scratch/route'
import { strings } from '@/ui/strings'

// A project from scratch: the app makes the folder an empty repository with one commit and nothing else, refuses a
// folder that holds someone's files, and keeps what was chosen (models, rules, folders to ask about) on the project.

beforeAll(() => migrateDb())
const dirs: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'factory-scratch-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const e = strings.wizard.errors

test('a new folder becomes a repository on main with a README and one commit, and origin is remembered', () => {
  const path = join(temp(), 'my-landing')
  expect(startFromScratch({ path: `${path}/`, name: 'My landing', githubUrl: ' https://github.com/me/my-landing ' })).toBe(path)
  expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  expect(git(path, 'rev-list', '--count', 'HEAD')).toBe('1')
  expect(readFileSync(join(path, 'README.md'), 'utf8')).toContain('# My landing')
  expect(git(path, 'remote', 'get-url', 'origin')).toBe('https://github.com/me/my-landing')
  expect(git(path, 'status', '--porcelain')).toBe('')
})

test('an empty folder that exists is taken; without an address there is no origin', () => {
  const path = temp()
  writeFileSync(join(path, '.DS_Store'), '')
  startFromScratch({ path, name: 'x' })
  expect(() => git(path, 'remote', 'get-url', 'origin')).toThrow()
})

test('a folder with files, a file, a missing parent and a relative path are refused, and nothing is created', () => {
  const full = temp()
  writeFileSync(join(full, 'notes.txt'), 'mine')
  expect(() => startFromScratch({ path: full, name: 'x' })).toThrow(e.notEmpty)
  expect(existsSync(join(full, '.git'))).toBe(false)
  expect(() => checkNewFolder(join(full, 'notes.txt'))).toThrow(e.notFolder)
  expect(() => checkNewFolder(join(full, 'missing', 'deeper'))).toThrow(e.noParent)
  expect(() => checkNewFolder('my-project')).toThrow(strings.settings.notAbsolute)
})

test('only a github.com address is taken, never one carrying a name and password, and a bad one creates nothing', () => {
  expect(cleanGitHubUrl('')).toBeNull()
  expect(cleanGitHubUrl('git@github.com:me/x.git')).toBe('git@github.com:me/x.git')
  for (const bad of ['https://gitlab.com/me/x', 'https://github.com.evil.example/me/x', 'https://me:secret@github.com/me/x', 'not an address']) {
    expect(() => cleanGitHubUrl(bad)).toThrow(e.notGitHub)
  }
  const path = join(temp(), 'p')
  expect(() => startFromScratch({ path, name: 'p', githubUrl: 'https://gitlab.com/me/p' })).toThrow(e.notGitHub)
  expect(existsSync(path)).toBe(false)
})

test('the models chosen are kept on their blocks, and "default" stores nothing', async () => {
  const path = startFromScratch({ path: join(temp(), 'm'), name: 'm' })
  const { workflowId } = await createProject({ path, name: 'm', testCommand: null, checks: [], models: { plan: 'haiku', build: 'opus', review: 'default' } })
  const graph = JSON.parse((await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0]!.draftJson) as Graph
  const model = (kind: string) => graph.blocks.find(b => b.kind === kind)!.config.model
  expect(model('plan')).toBe('haiku')
  expect(model('build')).toBe('opus')
  expect(model('review')).toBeUndefined()
  expect(model('tests')).toBeUndefined()
})

test('folders to ask about become core areas; one that does not exist is left out without losing the project', async () => {
  const path = startFromScratch({ path: join(temp(), 'c'), name: 'c' })
  mkdirSync(join(path, 'src', 'checkout'), { recursive: true })
  const { projectId } = await createProject({ path, name: 'c', testCommand: null, checks: [], coreAreas: ['src/checkout/', 'nowhere/'] })
  const core = (await listRegister(projectId)).filter(x => x.kind === 'core').flatMap(x => x.paths)
  expect(core).toContain('src/checkout/')
})

test('the folders offered are the project\'s own: top level and inside src, never node_modules or hidden ones', () => {
  const dir = temp()
  for (const f of ['src/app', 'src/lib', 'docs', 'node_modules/x', '.git/x', 'dist']) mkdirSync(join(dir, f), { recursive: true })
  expect(foldersOf(dir)).toEqual(['docs/', 'src/app/', 'src/lib/'])
})

const post = (body: unknown) => POST(new Request('http://127.0.0.1/api/projects/scratch', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' }, body: JSON.stringify(body) }))

test('from the wizard: the project exists, what was chosen is a standing rule, and the first task is written', async () => {
  const path = join(temp(), 'shop')
  const res = await post({ path, name: 'Shop', githubUrl: null, stack: { frontEnd: 'nextjs', backEnds: ['prisma', 'made-up'] }, addTests: true, models: { plan: 'sonnet' } })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { projectId: string; workflowId: string; firstTask: string }
  expect(body.firstTask).toContain('Create the project "Shop"')
  expect(body.firstTask).toContain('Next.js and Prisma')
  expect(body.firstTask).toContain('Add tests')
  expect((await rulesFor(body.projectId)).map(r => r.text)).toEqual(expect.arrayContaining(['This project is built with Next.js and Prisma.', strings.wizard.rules.tests]))
  // What the app made is a folder the other way in can read.
  expect((await analyzeProject(path, async () => 'ready')).defaultBranch).toBe('main')
})

test('from the wizard: nothing picked and no tests leaves no rule and says the agents choose; a full folder is refused in plain words', async () => {
  const path = join(temp(), 'free')
  const res = await post({ path, name: 'Free', addTests: false })
  const body = (await res.json()) as { projectId: string; firstTask: string }
  expect(body.firstTask).toContain('Choose what to build it with')
  expect(body.firstTask).not.toContain('Add tests')
  expect(await rulesFor(body.projectId)).toEqual([])
  const again = await post({ path, name: 'Free', addTests: false })
  expect(again.status).toBe(400)
  expect(((await again.json()) as { error: string }).error).toBe(e.notEmpty)
})

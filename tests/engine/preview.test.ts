import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { copyEnvFiles, devCommand, previewState, startPreview, stopPreview } from '@/engine/preview'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { POST } from '@/app/api/runs/[runId]/preview/route'

beforeAll(() => migrateDb())
const tmp = () => mkdtempSync(join(tmpdir(), 'factory-preview-'))
const pkg = (dir: string, body: object, lock?: string) => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(body))
  if (lock) writeFileSync(join(dir, lock), '')
}

test('the dev command follows the lockfile, and passes port and host the way the framework reads them', () => {
  const next = tmp()
  pkg(next, { scripts: { dev: 'next dev' }, dependencies: { next: '16' } }, 'pnpm-lock.yaml')
  expect(devCommand(next, 4200)!.argv).toEqual(['pnpm', 'run', 'dev', '-p', '4200', '-H', '127.0.0.1'])
  const vite = tmp()
  pkg(vite, { scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }, 'package-lock.json')
  expect(devCommand(vite, 4201)!.argv).toEqual(['npm', 'run', 'dev', '--', '--port', '4201', '--host', '127.0.0.1', '--strictPort'])
  const plain = tmp()
  pkg(plain, { scripts: { dev: 'node server.js' } }, 'yarn.lock')
  expect(devCommand(plain, 4202)!.argv).toEqual(['yarn', 'dev'])
})

test('dependencies are installed first only when the copy has none', () => {
  const dir = tmp()
  pkg(dir, { scripts: { dev: 'x' } }, 'pnpm-lock.yaml')
  expect(devCommand(dir, 1)!.installArgv).toEqual(['pnpm', 'install'])
  mkdirSync(join(dir, 'node_modules'))
  expect(devCommand(dir, 1)!.installArgv).toBeNull()
})

test('without a dev script there is nothing to start', () => {
  const dir = tmp()
  pkg(dir, { scripts: { test: 'x' } })
  expect(devCommand(dir, 1)).toBeNull()
  expect(devCommand(tmp(), 1)).toBeNull()
})

test('the project\'s untracked env files are copied, examples are not, and nothing already there is overwritten', () => {
  const repo = tmp()
  const wt = tmp()
  writeFileSync(join(repo, '.env.local'), 'SECRET=1')
  writeFileSync(join(repo, '.env'), 'A=1')
  writeFileSync(join(repo, '.env.example'), 'SECRET=')
  writeFileSync(join(wt, '.env'), 'A=already-here')
  expect(copyEnvFiles(repo, wt)).toEqual(['.env.local'])
  expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('A=already-here')
  expect(existsSync(join(wt, '.env.example'))).toBe(false)
})

/** A run whose worktree is a tiny project with a real dev server, and whose project has an env file to copy. */
async function runWithServer(): Promise<{ runId: string; wt: string }> {
  const repo = tmp()
  writeFileSync(join(repo, '.env.local'), 'GREETING=hello-from-env')
  const wt = tmp()
  mkdirSync(join(wt, 'node_modules'))
  pkg(wt, { scripts: { dev: 'node server.js' } }, 'package-lock.json')
  // Serves the env value it was started with, so the test can see the copied env file was used.
  writeFileSync(join(wt, 'server.js'), `
    const fs = require('fs')
    const env = fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8') : 'no env'
    require('http').createServer((_q, r) => r.end(env)).listen(Number(process.env.PORT), process.env.HOST)
  `)
  execFileSync('git', ['init', '-q'], { cwd: wt })
  const projectId = ulid()
  const workflowId = ulid()
  db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: new Date().toISOString(), repoPath: repo }).run()
  db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: '', updatedAt: '' }).run()
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'r' })
  db.update(runs).set({ worktreePath: wt, baseCommit: 'x' }).where(eq(runs.id, runId)).run()
  return { runId, wt }
}

test('a preview starts the project from the agent\'s copy, with the project\'s env, on loopback, and stops', async () => {
  const { runId } = await runWithServer()
  await startPreview(runId)
  await vi.waitFor(() => expect(previewState(runId).status).toBe('ready'), { timeout: 15_000, interval: 200 })
  const { url } = previewState(runId)
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  expect(await (await fetch(url!)).text()).toBe('GREETING=hello-from-env')
  stopPreview(runId)
  expect(previewState(runId).status).toBe('stopped')
  await vi.waitFor(async () => expect(await fetch(url!).then(() => 'up', () => 'down')).toBe('down'), { timeout: 8000, interval: 200 })
}, 30_000)

test('asking twice joins the preview already running instead of starting a second one', async () => {
  const { runId } = await runWithServer()
  await startPreview(runId)
  await vi.waitFor(() => expect(previewState(runId).status).toBe('ready'), { timeout: 15_000, interval: 200 })
  const first = previewState(runId).url
  await startPreview(runId)
  expect(previewState(runId).url).toBe(first)
  stopPreview(runId)
}, 30_000)

test('only the app\'s own page can start a preview', async () => {
  const { runId } = await runWithServer()
  const res = await POST(new Request(`http://localhost:4100/api/runs/${runId}/preview`, { method: 'POST', headers: { host: 'localhost:4100' } }), {
    params: Promise.resolve({ runId }),
  })
  expect(res.status).toBe(403)
  expect(previewState(runId).status).toBe('stopped')
})

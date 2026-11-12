import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProject, commandsOf, githubRepoOf, runScript, testCommandOnMain } from '@/engine/project-setup'

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-setup-'))
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), content)
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'me@example.com')
  git(dir, 'config', 'user.name', 'me')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

const nextPkg = JSON.stringify({
  name: 'comets-web',
  scripts: { dev: 'next dev', build: 'next build', lint: 'eslint', test: 'vitest run', typecheck: 'tsc --noEmit' },
  dependencies: { next: '16', react: '19' },
})

test('a Next.js project on pnpm, on GitHub, deployed by Vercel and checked by Actions, is read as such', async () => {
  const dir = repo({ 'package.json': nextPkg, 'pnpm-lock.yaml': '', '.vercel/project.json': '{}', '.github/workflows/ci.yml': 'on: push' })
  git(dir, 'remote', 'add', 'origin', 'https://github.com/alice/comets.git')
  const a = await analyzeProject(dir, async () => 'ready')
  expect(a).toMatchObject({
    name: 'comets-web',
    packageManager: 'pnpm',
    framework: 'Next.js',
    commands: { test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build', typecheck: 'pnpm typecheck' },
    defaultBranch: 'main',
    github: { repo: 'alice/comets', gh: 'ready' },
    deploy: ['Vercel', 'GitHub Actions: ci.yml'],
  })
})

test('missing pieces are said, not invented', async () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
  const a = await analyzeProject(dir, async () => 'ready')
  expect(a.packageManager).toBe('npm')
  expect(a.commands).toEqual({ test: null, lint: null, build: null, typecheck: null })
  expect(a.github).toEqual({ repo: null, gh: 'no-remote' })
  expect(a.framework).toBeNull()
  expect(a.deploy).toEqual([])
  git(dir, 'remote', 'add', 'origin', 'https://gitlab.com/a/b.git')
  expect((await analyzeProject(dir, async () => 'ready')).github).toEqual({ repo: null, gh: 'not-github' })
})

test('scripts run the way the project installs', () => {
  expect(runScript('npm', 'test')).toBe('npm test')
  expect(runScript('npm', 'lint')).toBe('npm run lint')
  expect(runScript('yarn', 'build')).toBe('yarn build')
  expect(runScript('bun', 'lint')).toBe('bun run lint')
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { 'type-check': 'tsc' } }), 'yarn.lock': '' })
  expect(commandsOf(dir).typecheck).toBe('yarn type-check')
})

test('a GitHub remote gives owner/name, never a token in it', () => {
  expect(githubRepoOf('https://user:ghp_secret@github.com/alice/shop.git')).toBe('alice/shop')
  expect(githubRepoOf('git@github.com:alice/shop.git')).toBe('alice/shop')
  expect(githubRepoOf('https://gitlab.com/a/b')).toBeNull()
})

test('tests that arrive on the main branch are noticed; ones only on a side branch, or the npm placeholder, are not', () => {
  const dir = repo({ 'package.json': JSON.stringify({ name: 'landing', scripts: { build: 'next build', test: 'echo "Error: no test specified" && exit 1' } }) })
  expect(testCommandOnMain(dir)).toBeNull()

  // A task's branch gets tests: not on main yet, so nothing is offered.
  git(dir, 'checkout', '-q', '-b', 'ai/add-tests')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'landing', scripts: { build: 'next build', test: 'vitest run' } }))
  git(dir, 'commit', '-q', '-am', 'add tests')
  expect(testCommandOnMain(dir)).toBeNull()

  // Merged into main: now it is.
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'merge', '-q', 'ai/add-tests')
  expect(testCommandOnMain(dir)).toBe('npm test')
})

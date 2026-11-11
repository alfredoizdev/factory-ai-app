import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchCommit, defaultBranch } from '@/engine/branches'

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function repo(first = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'factory-branches-'))
  git(dir, 'init', '-q', '-b', first)
  git(dir, 'config', 'user.email', 'me@example.com')
  git(dir, 'config', 'user.name', 'me')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'a')
  return dir
}

test('the main branch is found whatever branch the project is on', () => {
  const dir = repo()
  git(dir, 'checkout', '-q', '-b', 'ai/feature')
  expect(defaultBranch(dir)).toBe('main')
})

test('master counts too, and origin/HEAD wins when it is set', () => {
  const old = repo('master')
  expect(defaultBranch(old)).toBe('master')
  const dir = repo('trunk')
  const origin = mkdtempSync(join(tmpdir(), 'factory-origin-'))
  git(origin, 'init', '-q', '--bare', '-b', 'trunk')
  git(dir, 'remote', 'add', 'origin', origin)
  git(dir, 'push', '-q', 'origin', 'trunk')
  git(dir, 'remote', 'set-head', 'origin', 'trunk')
  git(dir, 'checkout', '-q', '-b', 'other')
  expect(defaultBranch(dir)).toBe('trunk')
})

test('with no main branch at all, the current one is used', () => {
  const dir = repo('work')
  expect(defaultBranch(dir)).toBe('work')
})

test('a branch resolves to its commit; anything else is null', () => {
  const dir = repo()
  expect(branchCommit(dir, 'main')).toBe(git(dir, 'rev-parse', 'main'))
  expect(branchCommit(dir, 'nope')).toBeNull()
  expect(branchCommit(dir, '--upload-pack=evil')).toBeNull()
  expect(branchCommit(dir, 'main^{tree}')).toBeNull()
})

describe('starting from the newest main', () => {
  async function withOrigin() {
    const { freshestStart } = await import('@/engine/branches')
    const dir = repo()
    const origin = mkdtempSync(join(tmpdir(), 'factory-origin-'))
    git(origin, 'init', '-q', '--bare', '-b', 'main')
    git(dir, 'remote', 'add', 'origin', origin)
    git(dir, 'push', '-q', 'origin', 'main')
    return { freshestStart, dir, origin }
  }

  test('a pull request merged on origin is where the task starts, even when the local main was never pulled', async () => {
    const { freshestStart, dir, origin } = await withOrigin()
    const other = mkdtempSync(join(tmpdir(), 'factory-other-'))
    git(other, 'clone', '-q', origin, '.')
    git(other, 'config', 'user.email', 'o@example.com')
    git(other, 'config', 'user.name', 'o')
    writeFileSync(join(other, 'a.txt'), 'merged\n')
    git(other, 'commit', '-qam', 'merged PR')
    git(other, 'push', '-q', 'origin', 'main')
    const merged = git(other, 'rev-parse', 'HEAD')
    expect(await freshestStart(dir, 'main')).toEqual({ commit: merged, fromOrigin: true })
    expect(git(dir, 'rev-parse', 'main')).not.toBe(merged) // their own main is not moved
  })

  test('local commits origin lacks are kept', async () => {
    const { freshestStart, dir } = await withOrigin()
    writeFileSync(join(dir, 'a.txt'), 'mine\n')
    git(dir, 'commit', '-qam', 'mine')
    expect(await freshestStart(dir, 'main')).toEqual({ commit: git(dir, 'rev-parse', 'main'), fromOrigin: false })
  })

  test('no origin, or an unreachable one, uses the local branch', async () => {
    const { freshestStart } = await import('@/engine/branches')
    const dir = repo()
    expect(await freshestStart(dir, 'main')).toEqual({ commit: git(dir, 'rev-parse', 'main'), fromOrigin: false })
    git(dir, 'remote', 'add', 'origin', '/nowhere/at/all')
    expect(await freshestStart(dir, 'main')).toEqual({ commit: git(dir, 'rev-parse', 'main'), fromOrigin: false })
  })
})

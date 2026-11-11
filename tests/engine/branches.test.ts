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

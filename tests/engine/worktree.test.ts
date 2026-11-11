import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunWorktree } from '@/engine/worktree'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-repo-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
const root = () => mkdtempSync(join(tmpdir(), 'factory-wt-root-'))

test('a run gets its own worktree on a new branch off HEAD, and the original checkout is untouched', () => {
  const repo = repoWithCommit()
  const head = git(repo, 'rev-parse', 'HEAD')
  const ws = createRunWorktree(repo, '01ABCRUN', root())
  expect(ws.branch).toBe('factory/01abcrun')
  expect(ws.baseCommit).toBe(head)
  expect(existsSync(join(ws.path, 'a.txt'))).toBe(true)
  expect(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('factory/01abcrun')
  expect(git(repo, 'status', '--porcelain')).toBe('')
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
})

test('creating it again for the same run (a replay) returns the same worktree', () => {
  const repo = repoWithCommit()
  const r = root()
  const first = createRunWorktree(repo, 'RUN2', r)
  const again = createRunWorktree(repo, 'RUN2', r)
  expect(again).toEqual(first)
})

test('a repository with no commits cannot give a run a worktree', () => {
  const empty = mkdtempSync(join(tmpdir(), 'factory-empty-'))
  git(empty, 'init', '-q')
  expect(() => createRunWorktree(empty, 'RUN3', root())).toThrow()
})

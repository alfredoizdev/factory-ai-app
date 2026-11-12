import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FIX_ATTEMPTS, changedBetween, changedSince, restoreTree, snapshotTree } from '@/engine/tree-snapshot'

// A snapshot of the task's folder that the person's own git state never feels: no commit, no stash, no change to the real index.

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), content)
}
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8')

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-snap-'))
  git(dir, 'init', '-q')
  put(dir, '.gitignore', 'node_modules/\n')
  put(dir, 'a.txt', 'a1\n')
  put(dir, 'b.txt', 'b1\n')
  put(dir, 'src/c.txt', 'c1\n')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
  return dir
}
const stateOf = (dir: string) => ({ status: git(dir, 'status', '--porcelain'), staged: git(dir, 'diff', '--cached'), head: git(dir, 'rev-parse', 'HEAD'), stash: git(dir, 'stash', 'list'), refs: git(dir, 'for-each-ref') })

test('a limit on attempts exists', () => {
  expect(MAX_FIX_ATTEMPTS).toBe(2)
})

describe('snapshotTree, changedSince, restoreTree', () => {
  test('a changed, an added and a deleted file are listed, and put back as they were', () => {
    const dir = repo()
    put(dir, 'b.txt', 'b2 staged\n')
    git(dir, 'add', 'b.txt')
    put(dir, 'a.txt', 'a2 unstaged\n')
    put(dir, 'new-before.txt', 'untracked before\n')
    const before = stateOf(dir)
    const tree = snapshotTree(dir)
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(stateOf(dir)).toEqual(before)
    expect(changedSince(dir, tree)).toEqual([])

    put(dir, 'a.txt', 'a3 edited by a fix\n')
    put(dir, 'added/by-fix.txt', 'new\n')
    rmSync(join(dir, 'src/c.txt'))
    expect(changedSince(dir, tree)).toEqual(['a.txt', 'added/by-fix.txt', 'src/c.txt'])

    restoreTree(dir, tree)
    expect(read(dir, 'a.txt')).toBe('a2 unstaged\n')
    expect(read(dir, 'src/c.txt')).toBe('c1\n')
    expect(read(dir, 'b.txt')).toBe('b2 staged\n')
    expect(read(dir, 'new-before.txt')).toBe('untracked before\n')
    expect(existsSync(join(dir, 'added/by-fix.txt'))).toBe(false)
    expect(existsSync(join(dir, 'added'))).toBe(false)
    expect(changedSince(dir, tree)).toEqual([])
    expect(stateOf(dir)).toEqual(before)
  })

  test('a file in .gitignore is not in the snapshot and is never touched', () => {
    const dir = repo()
    put(dir, 'node_modules/pkg/index.js', 'one\n')
    const tree = snapshotTree(dir)
    expect(git(dir, 'ls-tree', '-r', '--name-only', tree)).not.toContain('node_modules')
    put(dir, 'node_modules/pkg/index.js', 'two\n')
    put(dir, 'node_modules/pkg/extra.js', 'extra\n')
    put(dir, 'a.txt', 'changed\n')
    expect(changedSince(dir, tree)).toEqual(['a.txt'])
    restoreTree(dir, tree)
    expect(read(dir, 'node_modules/pkg/index.js')).toBe('two\n')
    expect(read(dir, 'node_modules/pkg/extra.js')).toBe('extra\n')
    expect(read(dir, 'a.txt')).toBe('a1\n')
  })

  test('a file replaced by a folder, and a folder by a file, come back', () => {
    const dir = repo()
    const tree = snapshotTree(dir)
    rmSync(join(dir, 'a.txt'))
    put(dir, 'a.txt/inside.txt', 'x\n')
    rmSync(join(dir, 'src'), { recursive: true })
    put(dir, 'src', 'now a file\n')
    restoreTree(dir, tree)
    expect(read(dir, 'a.txt')).toBe('a1\n')
    expect(read(dir, 'src/c.txt')).toBe('c1\n')
    expect(changedSince(dir, tree)).toEqual([])
  })

  test('a tree id that is not a hex object id is refused, and nothing is run or changed', () => {
    const dir = repo()
    put(dir, 'a.txt', 'keep me\n')
    for (const bad of ['', 'HEAD', '--help', 'abc', 'zz'.repeat(20), `${'a'.repeat(40)}; touch hacked`, '$(touch hacked)', `${'a'.repeat(40)}\n`]) {
      expect(() => restoreTree(dir, bad)).toThrow()
      expect(() => changedSince(dir, bad)).toThrow()
    }
    expect(read(dir, 'a.txt')).toBe('keep me\n')
    expect(existsSync(join(dir, 'hacked'))).toBe(false)
  })

  test('a folder that is not itself a repository is refused, even inside another one', () => {
    const outer = repo()
    const inner = join(outer, 'plain')
    mkdirSync(inner)
    expect(() => snapshotTree(inner)).toThrow()
  })

  test('changedBetween lists what differs between a commit and a tree', () => {
    const dir = repo()
    const base = git(dir, 'rev-parse', 'HEAD').trim()
    put(dir, 'a.txt', 'changed by the task\n')
    put(dir, 'extra.txt', 'x\n')
    const tree = snapshotTree(dir)
    expect(changedBetween(dir, base, tree)).toEqual(['a.txt', 'extra.txt'])
    expect(() => changedBetween(dir, '--bad', tree)).toThrow()
  })
})

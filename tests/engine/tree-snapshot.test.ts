import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FIX_ATTEMPTS, changedBetween, changedPaths, changedSince, diffSince, looseChanges, measureSince, releaseAttempts, restoreTree, snapshotTree, startAttempt, takeSnap, undoChange } from '@/engine/tree-snapshot'

// A snapshot of the task's folder that the person's own git state never feels, and an undo that only touches what a fix changed.

const temps: string[] = []
afterAll(() => temps.forEach(t => rmSync(t, { recursive: true, force: true })))
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'factory-snap-'))
  temps.push(d)
  return d
}
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
const commit = (dir: string, message: string) => git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message)
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), content)
}
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8')

let store: string
beforeEach(() => {
  store = temp()
})
const opts = () => ({ store })

function repo(): string {
  const dir = temp()
  git(dir, 'init', '-q')
  put(dir, '.gitignore', '.env\n.env.*\nnode_modules/\n*.log\n')
  put(dir, 'a.txt', 'a1\n')
  put(dir, 'b.txt', 'b1\n')
  put(dir, 'src/c.txt', 'c1\n')
  git(dir, 'add', '.')
  commit(dir, 'base')
  put(dir, '.env', 'SECRET=1\n')
  put(dir, 'node_modules/pkg/index.js', 'one\n')
  put(dir, 'debug.log', 'log\n')
  return dir
}
const stateOf = (dir: string) => ({ status: git(dir, 'status', '--porcelain'), staged: git(dir, 'diff', '--cached'), head: git(dir, 'rev-parse', 'HEAD'), stash: git(dir, 'stash', 'list'), refs: git(dir, 'for-each-ref') })
const looseObjects = (dir: string) => readdirSync(join(dir, '.git/objects')).filter(d => /^[0-9a-f]{2}$/.test(d)).flatMap(d => readdirSync(join(dir, '.git/objects', d)))
const untouched = (dir: string) => {
  expect(read(dir, '.env')).toBe('SECRET=1\n')
  expect(read(dir, 'node_modules/pkg/index.js')).toBe('one\n')
  expect(read(dir, 'debug.log')).toBe('log\n')
}

test('a limit on attempts exists', () => {
  expect(MAX_FIX_ATTEMPTS).toBe(2)
})

describe('snapshotTree, changedSince, restoreTree', () => {
  test('a changed, an added and a deleted file are listed, and put back as they were; the real git state is the same', () => {
    const dir = repo()
    put(dir, 'b.txt', 'b2 staged\n')
    git(dir, 'add', 'b.txt')
    put(dir, 'a.txt', 'a2 unstaged\n')
    put(dir, 'new-before.txt', 'untracked before\n')
    const before = stateOf(dir)
    const tree = snapshotTree(dir, opts())
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(stateOf(dir)).toEqual(before)
    expect(changedSince(dir, tree, opts())).toEqual([])

    put(dir, 'a.txt', 'a3 edited by a fix\n')
    put(dir, 'added/by-fix.txt', 'new\n')
    rmSync(join(dir, 'src/c.txt'))
    expect(changedSince(dir, tree, opts())).toEqual(['a.txt', 'added/by-fix.txt', 'src/c.txt'])

    restoreTree(dir, tree, opts())
    expect(read(dir, 'a.txt')).toBe('a2 unstaged\n')
    expect(read(dir, 'src/c.txt')).toBe('c1\n')
    expect(read(dir, 'b.txt')).toBe('b2 staged\n')
    expect(read(dir, 'new-before.txt')).toBe('untracked before\n')
    expect(existsSync(join(dir, 'added/by-fix.txt'))).toBe(false)
    expect(changedSince(dir, tree, opts())).toEqual([])
    expect(stateOf(dir)).toEqual(before)
    untouched(dir)
  })

  test('snapshots live in the app\'s store: the repository gets no new objects, and git gc cannot take a snapshot away', () => {
    const dir = repo()
    const objectsBefore = looseObjects(dir).sort()
    const tree = snapshotTree(dir, opts())
    put(dir, 'brand-new.txt', 'only in the snapshot\n')
    const tree2 = snapshotTree(dir, opts())
    expect(looseObjects(dir).sort()).toEqual(objectsBefore)
    expect(readdirSync(join(store, 'objects')).length).toBeGreaterThan(0)
    git(dir, 'gc', '--prune=now', '-q')
    put(dir, 'a.txt', 'changed\n')
    rmSync(join(dir, 'brand-new.txt'))
    restoreTree(dir, tree2, opts())
    expect(read(dir, 'brand-new.txt')).toBe('only in the snapshot\n')
    expect(read(dir, 'a.txt')).toBe('a1\n')
    expect(changedBetween(dir, tree, tree2, opts())).toEqual(['brand-new.txt'])
  })

  test('a file replaced by a folder, and a folder by a file, come back; no folder is ever removed', () => {
    const dir = repo()
    const tree = snapshotTree(dir, opts())
    rmSync(join(dir, 'a.txt'))
    put(dir, 'a.txt/inside.txt', 'x\n')
    rmSync(join(dir, 'src'), { recursive: true })
    put(dir, 'src', 'now a file\n')
    restoreTree(dir, tree, opts())
    expect(read(dir, 'a.txt')).toBe('a1\n')
    expect(read(dir, 'src/c.txt')).toBe('c1\n')
    expect(changedSince(dir, tree, opts())).toEqual([])
    // a folder the fix made and the person had before is not pruned
    const t2 = snapshotTree(dir, opts())
    mkdirSync(join(dir, 'empty-folder'))
    put(dir, 'empty-folder/x.txt', 'x')
    restoreTree(dir, t2, opts())
    expect(existsSync(join(dir, 'empty-folder'))).toBe(true)
  })

  test('a tree id that is not a hex object id is refused, and nothing is run or changed', () => {
    const dir = repo()
    put(dir, 'a.txt', 'keep me\n')
    for (const bad of ['', 'HEAD', '--help', 'abc', 'zz'.repeat(20), `${'a'.repeat(40)}; touch hacked`, '$(touch hacked)', `${'a'.repeat(40)}\n`]) {
      expect(() => restoreTree(dir, bad, opts())).toThrow()
      expect(() => changedSince(dir, bad, opts())).toThrow()
      expect(() => undoChange(dir, bad, bad, opts())).toThrow()
    }
    expect(read(dir, 'a.txt')).toBe('keep me\n')
    expect(existsSync(join(dir, 'hacked'))).toBe(false)
  })

  test('a folder that is not itself a repository is refused, even inside another one', () => {
    const outer = repo()
    const inner = join(outer, 'plain')
    mkdirSync(inner)
    expect(() => snapshotTree(inner, opts())).toThrow()
  })

  test('works in a git worktree, whose .git is a file', () => {
    const main = repo()
    const wt = join(temp(), 'wt')
    git(main, 'worktree', 'add', '-q', '-b', 'other', wt)
    const tree = snapshotTree(wt, opts())
    put(wt, 'a.txt', 'edited\n')
    put(wt, 'new.txt', 'n')
    restoreTree(wt, tree, opts())
    expect(read(wt, 'a.txt')).toBe('a1\n')
    expect(existsSync(join(wt, 'new.txt'))).toBe(false)
    const snap = takeSnap(wt, opts())
    put(wt, 'b.txt', 'edited\n')
    expect(undoChange(wt, snap, takeSnap(wt, opts()), opts()).reverted).toEqual(['b.txt'])
    expect(read(wt, 'b.txt')).toBe('b1\n')
  })
})

describe('restoring and undoing never touch what was ignored', () => {
  test('a fixer that rewrites .gitignore does not make a restore or an undo delete .env, node_modules or logs', () => {
    for (const how of ['restore', 'undo'] as const) {
      const dir = repo()
      const before = takeSnap(dir, opts())
      put(dir, '.gitignore', '*.log\n') // un-ignores .env and node_modules/
      put(dir, 'a.txt', 'fixed\n')
      const after = takeSnap(dir, opts())
      if (how === 'restore') restoreTree(dir, before.tree, opts())
      else undoChange(dir, before, after, opts())
      untouched(dir)
      expect(read(dir, '.gitignore')).toBe('.env\n.env.*\nnode_modules/\n*.log\n')
      expect(read(dir, 'a.txt')).toBe('a1\n')
    }
  })
})

describe('undoChange', () => {
  test('puts back only what the fix changed; what the person changed since is kept, listed, and left alone', () => {
    const dir = repo()
    const before = takeSnap(dir, opts())
    put(dir, 'a.txt', 'a fixed\n')
    put(dir, 'added.txt', 'by the fix\n')
    put(dir, 'src/c.txt', 'c fixed\n')
    const after = takeSnap(dir, opts())
    // while the run waited, the person worked
    put(dir, 'b.txt', 'b by the person\n')
    put(dir, 'person-notes.md', 'notes\n')
    put(dir, 'src/c.txt', 'c fixed, then edited by the person\n')
    const result = undoChange(dir, before, after, opts())
    expect(result).toEqual({ reverted: ['a.txt', 'added.txt'], kept: ['src/c.txt'], failed: [] })
    expect(read(dir, 'a.txt')).toBe('a1\n')
    expect(existsSync(join(dir, 'added.txt'))).toBe(false)
    expect(read(dir, 'b.txt')).toBe('b by the person\n')
    expect(read(dir, 'person-notes.md')).toBe('notes\n')
    expect(read(dir, 'src/c.txt')).toBe('c fixed, then edited by the person\n')
  })

  test('a path the fix did not change is never touched, whatever its state; a file the fix deleted comes back; a mode change and a symlink are undone', () => {
    const dir = repo()
    put(dir, 'run.sh', '#!/bin/sh\n')
    chmodSync(join(dir, 'run.sh'), 0o644)
    symlinkSync('a.txt', join(dir, 'link'))
    const before = takeSnap(dir, opts())
    rmSync(join(dir, 'b.txt'))
    chmodSync(join(dir, 'run.sh'), 0o755)
    rmSync(join(dir, 'link'))
    symlinkSync('b.txt', join(dir, 'link'))
    const after = takeSnap(dir, opts())
    put(dir, 'a.txt', 'person edit\n')
    const result = undoChange(dir, before, after, opts())
    expect(result.reverted.sort()).toEqual(['b.txt', 'link', 'run.sh'])
    expect(read(dir, 'b.txt')).toBe('b1\n')
    expect(statSync(join(dir, 'run.sh')).mode & 0o111).toBe(0)
    expect(execFileSync('readlink', [join(dir, 'link')], { encoding: 'utf8' }).trim()).toBe('a.txt')
    expect(read(dir, 'a.txt')).toBe('person edit\n')
  })

  test('a fixer that edits an ignored .env is seen, and put back; a new ignored sensitive file is removed; a changed one the person touched is kept', () => {
    const dir = repo()
    put(dir, 'extra.log', 'not sensitive\n')
    const before = takeSnap(dir, opts())
    expect(before.ignored.map(f => f.path)).toEqual(['.env'])
    put(dir, '.env', 'SECRET=changed by the fix\n')
    put(dir, 'config/.env.local', 'NEW=1\n')
    put(dir, 'extra.log', 'changed but not sensitive\n')
    const after = takeSnap(dir, opts())
    expect(changedPaths(dir, before, after, opts())).toEqual(['.env'].concat(['config/.env.local']).sort())
    put(dir, 'config/.env.local', 'NEW=1\nperson added\n')
    const result = undoChange(dir, before, after, opts())
    expect(result.reverted).toEqual(['.env'])
    expect(result.kept).toEqual(['config/.env.local'])
    expect(read(dir, '.env')).toBe('SECRET=1\n')
    expect(read(dir, 'extra.log')).toBe('changed but not sensitive\n')
  })

  test('the ignored sensitive files are kept in the app\'s store, not the repository, with limits on how many', () => {
    const dir = repo()
    const objectsBefore = looseObjects(dir).sort()
    for (let i = 0; i < 60; i++) put(dir, `secrets/.env.${i}`, `v${i}`)
    put(dir, 'huge/.env.big', 'x'.repeat(1024 * 1024 + 1))
    const snap = takeSnap(dir, opts())
    expect(snap.ignored).toHaveLength(50)
    expect(snap.ignored.some(f => f.path === '.env')).toBe(true)
    expect(snap.skipped).toBeGreaterThanOrEqual(11)
    expect(looseObjects(dir).sort()).toEqual(objectsBefore)
  })

  test('a nested repository without a commit cannot be added: a snapshot fails, but undoChange from two snapshots taken before it still works path by path', () => {
    const dir = repo()
    const before = takeSnap(dir, opts())
    put(dir, 'a.txt', 'fixed\n')
    const after = takeSnap(dir, opts())
    mkdirSync(join(dir, 'sub'))
    git(join(dir, 'sub'), 'init', '-q')
    put(dir, 'sub/x.txt', 'x')
    expect(() => snapshotTree(dir, opts())).toThrow()
    expect(undoChange(dir, before, after, opts())).toEqual({ reverted: ['a.txt'], kept: [], failed: [] })
    expect(read(dir, 'a.txt')).toBe('a1\n')
  })

  test('a path that cannot be put back is listed as failed and the others still are', () => {
    const dir = repo()
    const before = takeSnap(dir, opts())
    rmSync(join(dir, 'src'), { recursive: true })
    put(dir, 'a.txt', 'fixed\n')
    const after = takeSnap(dir, opts())
    writeFileSync(join(dir, 'src'), 'a file now, where the folder was') // in the way of src/c.txt
    const result = undoChange(dir, before, after, opts())
    expect(result.reverted).toEqual(['a.txt'])
    expect(result.failed).toEqual(['src/c.txt'])
  })

  test('changedBetween lists what differs between a commit and a tree', () => {
    const dir = repo()
    const base = git(dir, 'rev-parse', 'HEAD').trim()
    put(dir, 'a.txt', 'changed by the task\n')
    put(dir, 'extra.txt', 'x\n')
    const tree = snapshotTree(dir, opts())
    expect(changedBetween(dir, base, tree, opts())).toEqual(['a.txt', 'extra.txt'])
    expect(() => changedBetween(dir, '--bad', tree, opts())).toThrow()
  })
})


describe('round 2', () => {
  test('the fixer rewrites .gitignore and the person edits it too: nothing that was ignored is deleted, and the files are listed as kept', () => {
    for (const how of ['undo', 'restore'] as const) {
      const dir = repo()
      const before = takeSnap(dir, opts())
      put(dir, '.gitignore', 'nothing is ignored now\n')
      put(dir, 'a.txt', 'fixed\n')
      const after = takeSnap(dir, opts())
      appendFileSync(join(dir, '.gitignore'), 'the person added this\n')
      if (how === 'undo') {
        const result = undoChange(dir, before, after, opts())
        expect(result.kept).toEqual(expect.arrayContaining(['.gitignore', 'node_modules/pkg/index.js', 'debug.log']))
        expect(result.reverted).toEqual(['a.txt'])
      } else {
        // the same case through restoreTree: its "after" is the folder as it is now
        expect(() => restoreTree(dir, before.tree, opts())).not.toThrow()
      }
      untouched(dir)
      expect(read(dir, 'a.txt')).toBe('a1\n')
    }
  })

  test('build and test output is not recorded as a sensitive ignored file, and does not show up as changed', () => {
    const dir = repo()
    put(dir, '.gitignore', '.env\n.next/\ncoverage/\ndist/\n')
    git(dir, 'add', '.gitignore')
    commit(dir, 'ignore output')
    const before = takeSnap(dir, opts())
    put(dir, '.next/server/app/api/auth/route.js', 'x')
    put(dir, 'coverage/src/auth/login.ts.html', 'x')
    put(dir, 'dist/auth/login.js', 'x')
    put(dir, 'deep/.next/secret-chunk.js', 'x')
    const after = takeSnap(dir, opts())
    expect(after.ignored.map(f => f.path)).toEqual(['.env'])
    expect(changedPaths(dir, before, after, opts())).toEqual([])
  })

  test('a file comes back as the person had it: line endings under autocrlf', () => {
    const dir = repo()
    git(dir, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(dir, 'crlf.txt'), 'l1\r\nl2\r\n')
    const before = takeSnap(dir, opts())
    writeFileSync(join(dir, 'crlf.txt'), 'changed\r\n')
    const after = takeSnap(dir, opts())
    // a change of line endings alone does not make the file "changed since the fix"
    writeFileSync(join(dir, 'crlf.txt'), 'changed\n')
    const result = undoChange(dir, before, after, opts())
    expect(result.kept).toEqual([])
    expect(readFileSync(join(dir, 'crlf.txt'), 'utf8')).toBe('l1\r\nl2\r\n')
  })

  test('a file comes back as the person had it: through a clean/smudge filter', () => {
    const dir = repo()
    git(dir, 'config', 'filter.up.clean', 'tr a-z A-Z')
    git(dir, 'config', 'filter.up.smudge', 'tr A-Z a-z')
    put(dir, '.gitattributes', '*.flt filter=up\n')
    writeFileSync(join(dir, 'x.flt'), 'hello\n')
    const before = takeSnap(dir, opts())
    writeFileSync(join(dir, 'x.flt'), 'changed\n')
    const after = takeSnap(dir, opts())
    expect(undoChange(dir, before, after, opts()).kept).toEqual([])
    expect(readFileSync(join(dir, 'x.flt'), 'utf8')).toBe('hello\n')
  })

  test('undoing twice: the second time reports the files as already put back, not as changed after the fix', () => {
    const dir = repo()
    const before = takeSnap(dir, opts())
    put(dir, 'a.txt', 'fixed\n')
    put(dir, 'added.txt', 'x')
    const after = takeSnap(dir, opts())
    const first = undoChange(dir, before, after, opts())
    const second = undoChange(dir, before, after, opts())
    expect(first).toEqual({ reverted: ['a.txt', 'added.txt'], kept: [], failed: [] })
    expect(second).toEqual(first)
  })

  test('an attempt remembers the tree from just before it started, and its marker can be released', () => {
    const dir = repo()
    const first = startAttempt(dir, 'f1-1', opts())
    expect(first).toMatchObject({ again: false, start: { ignored: [{ path: '.env' }] } })
    put(dir, 'a.txt', 'later\n')
    const again = startAttempt(dir, 'f1-1', opts())
    expect(again.again).toBe(true)
    restoreTree(dir, (again as { start: { tree: string } }).start.tree, opts())
    expect(read(dir, 'a.txt')).toBe('a1\n')
    expect(() => startAttempt(dir, '../x', opts())).toThrow()
    releaseAttempts(dir, 'f1', opts())
    expect(startAttempt(dir, 'f1-1', opts())).toMatchObject({ again: false })
    // a marker that is empty or malformed gives no start
    writeFileSync(join(store, 'attempts', 'f2-1'), '')
    expect(startAttempt(dir, 'f2-1', opts())).toEqual({ again: true, start: null })
    writeFileSync(join(store, 'attempts', 'f2-2'), '{"tree":"nope"}')
    expect(startAttempt(dir, 'f2-2', opts())).toEqual({ again: true, start: null })
  })

  test('looseChanges does not rewrite the real index file', async () => {
    const dir = repo()
    const snap = takeSnap(dir, opts())
    await new Promise(r => setTimeout(r, 1100))
    writeFileSync(join(dir, 'a.txt'), 'a1\n') // same content, newer time: a plain git status would refresh the index
    const before = readFileSync(join(dir, '.git/index'))
    looseChanges(dir, snap, opts())
    expect(readFileSync(join(dir, '.git/index')).equals(before)).toBe(true)
  })

  test('looseChanges names what differs from a snapshot, path by path, without taking a new snapshot', () => {
    const dir = repo()
    const snap = takeSnap(dir, opts())
    put(dir, 'a.txt', 'changed\n')
    put(dir, 'new.txt', 'n')
    rmSync(join(dir, 'b.txt'))
    put(dir, '.env', 'SECRET=changed\n')
    mkdirSync(join(dir, 'sub'))
    git(join(dir, 'sub'), 'init', '-q')
    put(dir, 'sub/x.txt', 'x')
    expect(looseChanges(dir, snap, opts())).toEqual(['.env', 'a.txt', 'b.txt', 'new.txt', 'sub'])
  })
})


describe('diffSince and measureSince: what changed since a snapshot, read only', () => {
  test('a unified diff from the snapshot to the folder now, with new files; the real git state and the folder are untouched', () => {
    const dir = repo()
    const tree = snapshotTree(dir, opts())
    expect(diffSince(dir, tree, opts())).toBe('')
    put(dir, 'a.txt', 'a2\n')
    put(dir, 'added/new.txt', 'hello\n')
    rmSync(join(dir, 'src/c.txt'))
    const before = stateOf(dir)
    const diff = diffSince(dir, tree, opts())
    expect(diff).toContain('diff --git a/a.txt b/a.txt')
    expect(diff).toContain('-a1')
    expect(diff).toContain('+a2')
    expect(diff).toContain('+hello')
    expect(diff).toContain('-c1')
    expect(diff).not.toContain('SECRET') // ignored files are not part of it
    expect(stateOf(dir)).toEqual(before)
    expect(read(dir, 'a.txt')).toBe('a2\n')
  })

  test('measureSince gives the paths, the diff and the lines changed per path from one snapshot', () => {
    const dir = repo()
    const tree = snapshotTree(dir, opts())
    put(dir, 'a.txt', 'a1\nmore\nlines\n')
    put(dir, 'new.txt', 'x\n')
    const m = measureSince(dir, tree, opts())
    expect(m.paths).toEqual(['a.txt', 'new.txt'])
    expect(m.files).toEqual([{ path: 'a.txt', lines: 2 }, { path: 'new.txt', lines: 1 }])
    expect(m.diff).toContain('+more')
    expect(m.paths).toEqual(changedSince(dir, tree, opts()))
  })

  test('something that is not a tree id is refused', () => {
    const dir = repo()
    expect(() => diffSince(dir, '--output=/tmp/x', opts())).toThrow()
    expect(() => measureSince(dir, 'HEAD', opts())).toThrow()
  })
})

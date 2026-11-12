import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  corrected,
  checkRepro,
  makeCopy,
  MAX_REPRO_BYTES,
  MAX_REPRO_FILES,
  parseRepro,
  parseVerifierAnswer,
  REPRO_GRACE_MS,
  REPRO_TAIL_CHARS,
  REPRO_TIMEOUT_MS,
  reproduced,
  runRepro,
  safeReproPath,
  type Repro,
} from '@/engine/repro'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'factory-repro-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repo(): string {
  const dir = tmp()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return dir
}
const status = (dir: string) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' })
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const live = new AbortController().signal
const script = (command: string, extra: Partial<Repro> = {}): Repro => ({ command, marker: 'MARKER-XYZ-1', files: [], ...extra })

describe('safeReproPath', () => {
  test.each(['tests/repro.test.ts', 'a.js', 'a/b/c.txt', 'src/.github/x.yml'])('%s is allowed', p => expect(safeReproPath(p)).toBe(true))
  test.each([
    '../x',
    'a/../../x',
    '/etc/x',
    '.git/hooks/pre-commit',
    '',
    'a\0b',
    '..\\x',
    'a\\..\\..\\x',
    '\\etc\\x',
    'C:\\x',
    'sub/.git/config',
    'a/.GIT/hooks/x',
    '.Git',
    'a/.git',
    'sub\\.git\\config',
    'a//b',
    'a/',
  ])('%j is refused', p => expect(safeReproPath(p)).toBe(false))
})

describe('parseRepro', () => {
  const answer = (o: object) => `I tried it.\n${JSON.stringify(o)}`
  const files = (p: string) => (p === 'r.test.ts' ? 'content' : null)
  const ok = { reproduced: true, command: 'node r.js', marker: 'MARKER-XYZ-1', files: ['r.test.ts'] }

  test('reads the command, the marker and the files from the answer, taking contents from the copy', () => {
    expect(parseRepro(answer(ok), files)).toEqual({ command: 'node r.js', marker: 'MARKER-XYZ-1', files: [{ path: 'r.test.ts', content: 'content' }] })
  })
  test('null when the answer says it did not reproduce, or has no answer', () => {
    expect(parseRepro(answer({ ...ok, reproduced: false }), files)).toBeNull()
    expect(parseRepro('no json here', files)).toBeNull()
  })
  test('null when any one path is unsafe', () => {
    expect(parseRepro(answer({ ...ok, files: ['r.test.ts', '../x'] }), p => (p === '../x' ? 'x' : 'c'))).toBeNull()
  })
  test('null when a file is missing or unreadable', () => {
    expect(parseRepro(answer({ ...ok, files: ['r.test.ts', 'gone.ts'] }), files)).toBeNull()
  })
  test('null with more than MAX_REPRO_FILES files', () => {
    const many = Array.from({ length: MAX_REPRO_FILES + 1 }, (_, i) => `f${i}.js`)
    expect(parseRepro(answer({ ...ok, files: many }), () => 'x')).toBeNull()
    expect(parseRepro(answer({ ...ok, files: many.slice(0, MAX_REPRO_FILES) }), () => 'x')).not.toBeNull()
  })
  test('null when the command or the marker is empty', () => {
    expect(parseRepro(answer({ ...ok, command: '  ' }), files)).toBeNull()
    expect(parseRepro(answer({ ...ok, marker: '' }), files)).toBeNull()
    expect(parseRepro(answer({ ...ok, marker: 5 }), files)).toBeNull()
  })

  test('a marker that is short, has a line break, or appears in the command is refused', () => {
    expect(parseRepro(answer({ ...ok, marker: 'MARK-1' }), files)).toBeNull()
    expect(parseRepro(answer({ ...ok, marker: 'MARKER-XYZ-1\nmore' }), files)).toBeNull()
    expect(parseRepro(answer({ ...ok, marker: 'MARKER-XYZ-1\rmore' }), files)).toBeNull()
    expect(parseRepro(answer({ ...ok, command: 'echo MARKER-XYZ-1', marker: 'MARKER-XYZ-1' }), files)).toBeNull()
    expect(parseRepro(answer({ ...ok, marker: '12345678' }), files)).not.toBeNull()
  })
  test('null when a file is over MAX_REPRO_BYTES, or all together are', () => {
    expect(parseRepro(answer(ok), () => 'x'.repeat(MAX_REPRO_BYTES + 1))).toBeNull()
    expect(parseRepro(answer(ok), () => 'x'.repeat(MAX_REPRO_BYTES))).not.toBeNull()
    expect(parseRepro(answer({ ...ok, files: ['a.js', 'b.js'] }), () => 'x'.repeat(MAX_REPRO_BYTES / 2 + 1))).toBeNull()
  })
  test('the last answer wins when the reply holds several', () => {
    const text = `${JSON.stringify({ ...ok, command: 'first' })}\nthen\n${JSON.stringify({ ...ok, command: 'second' })}`
    expect(parseRepro(text, files)?.command).toBe('second')
  })
})

describe('checkRepro says why an answer gives no repro', () => {
  const answer = (o: object) => `I tried it.\n${JSON.stringify(o)}`
  const files = (p: string) => (p === 'r.mjs' ? 'content' : null)
  const ok = { reproduced: true, command: 'node r.mjs', marker: 'MARKER-XYZ-1', files: ['r.mjs'] }
  const why = (text: string, read: (p: string) => string | null = files) => {
    const r = checkRepro(text, read)
    return 'why' in r ? r.why : 'ok'
  }

  test('a usable answer is the same repro parseRepro gives', () => {
    expect(checkRepro(answer(ok), files)).toEqual({ repro: parseRepro(answer(ok), files) })
  })
  test('each refusal has its own short reason', () => {
    expect(why('no json here')).toBe('no_answer')
    expect(why(answer({ reproduced: false }))).toBe('not_reproduced_by_verifier')
    expect(why(answer({ ...ok, command: ' ' }))).toBe('bad_command')
    expect(why(answer({ ...ok, marker: 'SHORT' }))).toBe('bad_marker')
    expect(why(answer({ ...ok, command: 'echo MARKER-XYZ-1' }))).toBe('bad_marker')
    expect(why(answer({ ...ok, files: 'r.mjs' }))).toBe('limits')
    expect(why(answer({ ...ok, files: Array.from({ length: MAX_REPRO_FILES + 1 }, (_, i) => `f${i}`) }), () => 'x')).toBe('limits')
    expect(why(answer(ok), () => 'x'.repeat(MAX_REPRO_BYTES + 1))).toBe('limits')
    expect(why(answer({ ...ok, files: ['gone.mjs'] }))).toBe('missing_file')
  })
  test('a script written outside the copy (an absolute path, as a real verifier did with /tmp) is an unsafe path', () => {
    const real = answer({ reproduced: true, command: 'node /tmp/repro_sum/r.mjs src/app/sum.ts', marker: 'BUG-SUM-WRONG-RESULT got 0', files: ['/tmp/repro_sum/r.mjs'] })
    expect(why(real, () => 'x')).toBe('unsafe_path')
    expect(parseRepro(real, () => 'x')).toBeNull()
  })
})

describe('parseVerifierAnswer', () => {
  test('reads reproduced and refuted with why', () => {
    expect(parseVerifierAnswer('{"reproduced":false,"refuted":true,"why":"x"}')).toEqual({ reproduced: false, refuted: { why: 'x' } })
    expect(parseVerifierAnswer('{"reproduced":false}')).toEqual({ reproduced: false })
    expect(parseVerifierAnswer('{"reproduced":true,"command":"c"}')).toEqual({ reproduced: true })
    expect(parseVerifierAnswer('nothing')).toBeNull()
  })
})

describe('reproduced and corrected', () => {
  const run = (exitCode: number | null, markerSeen: boolean) => ({ exitCode, markerSeen, outputTail: '', at: 'now' })
  test('reproduced needs a failing exit and the marker', () => {
    expect(reproduced(run(1, true))).toBe(true)
    expect(reproduced(run(1, false))).toBe(false)
    expect(reproduced(run(0, true))).toBe(false)
    expect(reproduced(run(null, true))).toBe(false)
    expect(corrected(run(0, false))).toBe(true)
    expect(corrected(run(1, true))).toBe(false)
    expect(corrected(run(null, false))).toBe(false)
  })
})

describe('runRepro', () => {
  test('a script that prints the marker and exits 1 reproduces the problem', async () => {
    const dir = repo()
    const r = await runRepro(script('echo MARKER-XYZ-1; exit 1'), dir, live, { root: tmp() })
    expect(r.exitCode).toBe(1)
    expect(r.markerSeen).toBe(true)
    expect(reproduced(r)).toBe(true)
    expect(r.outputTail).toContain('MARKER-XYZ-1')
    expect(Number.isNaN(Date.parse(r.at))).toBe(false)
  })

  test('failing without the marker (a syntax error) does not count', async () => {
    const r = await runRepro(script('echo oops >&2; exit 2'), repo(), live, { root: tmp() })
    expect(r.exitCode).toBe(2)
    expect(reproduced(r)).toBe(false)
  })

  test('exiting 0 counts as corrected', async () => {
    const r = await runRepro(script('exit 0'), repo(), live, { root: tmp() })
    expect(corrected(r)).toBe(true)
    expect(reproduced(r)).toBe(false)
  })

  test('the repro files are written in the copy and the command sees them', async () => {
    const r = await runRepro(script('cat r/x.txt; exit 1', { marker: 'inside-marker', files: [{ path: 'r/x.txt', content: 'inside-marker' }] }), repo(), live, { root: tmp() })
    expect(reproduced(r)).toBe(true)
  })

  test('the working copy is unchanged and the throwaway copy is gone', async () => {
    const dir = repo()
    const root = tmp()
    const before = { status: status(dir), hash: hash(join(dir, 'a.txt')) }
    const r = await runRepro(
      script('echo MARKER-XYZ-1; echo changed > a.txt; exit 1', { files: [{ path: 'new/r.js', content: 'x' }] }),
      dir,
      live,
      { root },
    )
    expect(reproduced(r)).toBe(true)
    expect({ status: status(dir), hash: hash(join(dir, 'a.txt')) }).toEqual(before)
    expect(existsSync(join(dir, 'new'))).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  test('while a copy exists the working copy is unchanged, and the copy is outside it', async () => {
    const dir = repo()
    const root = tmp()
    const before = status(dir)
    const copy = await makeCopy(dir, root)
    expect(copy.startsWith(`${root}/`)).toBe(true)
    expect(copy.startsWith(`${dir}/`)).toBe(false)
    expect(existsSync(join(copy, 'a.txt'))).toBe(true)
    expect(status(dir)).toBe(before)
    rmSync(copy, { recursive: true, force: true })
    expect(status(dir)).toBe(before)
  })

  test('the default place for copies is the app\'s own ignored .factory/verify folder', async () => {
    const dir = repo()
    const copy = await makeCopy(dir)
    try {
      expect(copy).toContain(join('.factory', 'verify'))
      execFileSync('git', ['check-ignore', '-q', copy], { cwd: process.cwd(), stdio: 'ignore' })
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  test('a command that never ends is stopped at the timeout and does not count', async () => {
    const root = tmp()
    const started = Date.now()
    const r = await runRepro(script('echo MARKER-XYZ-1; sleep 60'), repo(), live, { timeoutMs: 400, root })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.exitCode).toBeNull()
    expect(r.markerSeen).toBe(true)
    expect(reproduced(r)).toBe(false)
    expect(corrected(r)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  test('the timeout defaults to two minutes', () => {
    expect(REPRO_TIMEOUT_MS).toBe(120_000)
  })

  test('an aborted signal stops it and the copy is still removed', async () => {
    const root = tmp()
    const ctl = new AbortController()
    const pending = runRepro(script('sleep 60'), repo(), ctl.signal, { root })
    setTimeout(() => ctl.abort(), 300)
    const r = await pending
    expect(r.exitCode).toBeNull()
    expect(readdirSync(root)).toEqual([])
  })

  test('a noisy script cannot bloat the record', async () => {
    const r = await runRepro(script('yes noise | head -c 200000; echo; echo MARKER-XYZ-1; exit 1'), repo(), live, { root: tmp() })
    expect(r.outputTail.length).toBeLessThanOrEqual(REPRO_TAIL_CHARS)
    expect(reproduced(r)).toBe(true)
  })

  test('a symlinked folder in the tree does not let a file land outside the copy', async () => {
    const dir = repo()
    const outside = tmp()
    symlinkSync(outside, join(dir, 'link'))
    const root = tmp()
    const r = await runRepro(script('echo MARKER-XYZ-1; exit 1', { files: [{ path: 'link/evil.txt', content: 'x' }] }), dir, live, { root })
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
    expect(reproduced(r)).toBe(false)
    expect(r.exitCode).toBeNull()
    expect(r.markerSeen).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  test('a symlinked file in the tree is not written through', async () => {
    const dir = repo()
    const outside = tmp()
    writeFileSync(join(outside, 'target'), 'keep')
    symlinkSync(join(outside, 'target'), join(dir, 'sneaky.txt'))
    const r = await runRepro(script('exit 1', { files: [{ path: 'sneaky.txt', content: 'x' }] }), dir, live, { root: tmp() })
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('keep')
    expect(r.exitCode).toBeNull()
  })

  test('an unsafe path that got this far is refused without running, and the copy is removed', async () => {
    const root = tmp()
    mkdirSync(join(root, 'keep'))
    const r = await runRepro(script('echo MARKER-XYZ-1 > ../ran; exit 1', { files: [{ path: '../x', content: 'x' }] }), repo(), live, { root })
    expect(r.exitCode).toBeNull()
    expect(reproduced(r)).toBe(false)
    expect(readdirSync(root)).toEqual(['keep'])
    expect(existsSync(join(root, 'ran'))).toBe(false)
  })

  test('when writing a file throws, the copy is removed and nothing counts', async () => {
    const dir = repo()
    const root = tmp()
    // "a.txt" is a file, so "a.txt/x" cannot be a folder's child.
    const r = await runRepro(script('exit 1', { files: [{ path: 'a.txt/x', content: 'x' }] }), dir, live, { root })
    expect(reproduced(r)).toBe(false)
    expect(r.exitCode).toBeNull()
    expect(readdirSync(root)).toEqual([])
  })
  test('a failure that only echoes the marker does not count', async () => {
    const a = await runRepro(script('MARKER-XYZ-1', { marker: 'MARKER-XYZ-1' }), repo(), live, { root: tmp() })
    expect(a.exitCode).not.toBe(0)
    expect(a.outputTail).toContain('MARKER-XYZ-1')
    expect(reproduced(a)).toBe(false)
    const b = await runRepro(script(`node -e "console.log('MARKER-XYZ-1'"`, { marker: 'MARKER-XYZ-1' }), repo(), live, { root: tmp() })
    expect(b.exitCode).not.toBe(0)
    expect(reproduced(b)).toBe(false)
  })

  test('the marker counts when it is a line of its own', async () => {
    const r = await runRepro(script('echo "  MARKER-XYZ-1  "; exit 1'), repo(), live, { root: tmp() })
    expect(reproduced(r)).toBe(true)
  })

  test('an already aborted signal clones nothing and counts as not reproduced', async () => {
    const root = tmp()
    const ctl = new AbortController()
    ctl.abort()
    const r = await runRepro(script('echo MARKER-XYZ-1; exit 1'), repo(), ctl.signal, { root })
    expect(r.exitCode).toBeNull()
    expect(reproduced(r)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  test('a copy that cannot be made counts as not reproduced', async () => {
    const r = await runRepro(script('exit 1'), join(tmp(), 'does-not-exist'), live, { root: tmp() })
    expect(r.exitCode).toBeNull()
  })

  const hasPython = (() => {
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
  test.skipIf(!hasPython)('a process that leaves the group cannot hold the run past the deadline', async () => {
    const root = tmp()
    const started = Date.now()
    const r = await runRepro(
      script(`python3 -c "import os,time; os.setsid(); time.sleep(8)" & sleep 60`),
      repo(),
      live,
      { root, timeoutMs: 300, graceMs: 500 },
    )
    expect(Date.now() - started).toBeLessThan(300 + 500 + 2000)
    expect(r.exitCode).toBeNull()
    expect(reproduced(r)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  test('the grace after the timeout defaults to two seconds', () => {
    expect(REPRO_GRACE_MS).toBe(2000)
  })

  test.skipIf(process.getuid?.() === 0)('a copy that cannot be removed does not change what runRepro returns', async () => {
    const root = tmp()
    try {
      const r = await runRepro(script('chmod 555 .. ; echo MARKER-XYZ-1; exit 1'), repo(), live, { root })
      expect(reproduced(r)).toBe(true)
    } finally {
      chmodSync(root, 0o755)
    }
  })
})

describe('a copy of a task worktree', () => {
  function worktree() {
    const main = repo()
    const parent = tmp()
    const wt = join(parent, 'wt')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'task', wt], { cwd: main, stdio: 'ignore' })
    return { main, wt }
  }
  const out = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const snapshot = (main: string, wt: string) => ({
    head: out(wt, 'rev-parse', 'HEAD'),
    status: out(wt, 'status', '--porcelain'),
    stash: out(wt, 'stash', 'list'),
    list: out(main, 'worktree', 'list'),
    mainHead: out(main, 'rev-parse', 'HEAD'),
  })

  test('is a standalone repository: its git data is inside it', async () => {
    const { wt } = worktree()
    expect(readFileSync(join(wt, '.git'), 'utf8')).toContain('gitdir:')
    const root = tmp()
    const copy = await makeCopy(wt, root)
    try {
      expect(statSync(join(copy, '.git')).isDirectory()).toBe(true)
      const common = realpathSync(resolve(copy, out(copy, 'rev-parse', '--git-common-dir').trim()))
      expect(common.startsWith(`${realpathSync(copy)}/`)).toBe(true)
      expect(out(copy, 'status', '--porcelain')).toBe('')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  test('a repro that commits, stashes and resets in its copy leaves the real worktree and repository alone', async () => {
    const { main, wt } = worktree()
    const before = snapshot(main, wt)
    const r = await runRepro(
      script('echo x > new.txt && git add -A && git -c user.name=a -c user.email=a@a commit -qm x; echo y >> a.txt; git stash -q; git stash list; echo MARKER-XYZ-1; exit 1'),
      wt,
      live,
      { root: tmp() },
    )
    expect(reproduced(r)).toBe(true)
    expect(snapshot(main, wt)).toEqual(before)
  })

  test('a plain folder becomes a standalone repository too', async () => {
    const plain = tmp()
    writeFileSync(join(plain, 'f.txt'), 'x')
    const copy = await makeCopy(plain, tmp())
    try {
      expect(statSync(join(copy, '.git')).isDirectory()).toBe(true)
      expect(out(copy, 'status', '--porcelain')).toBe('')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
  test("the person's own git settings do not reach the copy's git: no hooks run and signing cannot break it", async () => {
    const hooks = tmp()
    const sentinel = join(tmp(), 'ran')
    writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\necho ran > ${sentinel}\n`, { mode: 0o755 })
    const config = join(tmp(), 'gitconfig')
    writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n`)
    const { wt } = worktree()
    const saved = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      const copy = await makeCopy(wt, tmp())
      rmSync(copy, { recursive: true, force: true })
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved
    }
  })

  test('a nested .git pointer file is removed from the copy and kept in the original', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'vendor/lib'), { recursive: true })
    writeFileSync(join(dir, 'vendor/lib/.git'), `gitdir: ${dir}/.git\n`)
    mkdirSync(join(dir, 'vendor/own/.git'), { recursive: true })
    writeFileSync(join(dir, 'vendor/own/.git/HEAD'), 'ref: refs/heads/x\n')
    const copy = await makeCopy(dir, tmp())
    try {
      expect(existsSync(join(copy, 'vendor/lib/.git'))).toBe(false)
      expect(existsSync(join(copy, 'vendor/own/.git/HEAD'))).toBe(true)
      expect(existsSync(join(dir, 'vendor/lib/.git'))).toBe(true)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})

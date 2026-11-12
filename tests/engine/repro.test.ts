import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  corrected,
  makeCopy,
  MAX_REPRO_BYTES,
  MAX_REPRO_FILES,
  parseRepro,
  parseVerifierAnswer,
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
const script = (command: string, extra: Partial<Repro> = {}): Repro => ({ command, marker: 'MARK-1', files: [], ...extra })

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
  const ok = { reproduced: true, command: 'node r.js', marker: 'MARK-1', files: ['r.test.ts'] }

  test('reads the command, the marker and the files from the answer, taking contents from the copy', () => {
    expect(parseRepro(answer(ok), files)).toEqual({ command: 'node r.js', marker: 'MARK-1', files: [{ path: 'r.test.ts', content: 'content' }] })
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
    const r = await runRepro(script('echo MARK-1; exit 1'), dir, live)
    expect(r.exitCode).toBe(1)
    expect(r.markerSeen).toBe(true)
    expect(reproduced(r)).toBe(true)
    expect(r.outputTail).toContain('MARK-1')
    expect(Number.isNaN(Date.parse(r.at))).toBe(false)
  })

  test('failing without the marker (a syntax error) does not count', async () => {
    const r = await runRepro(script('echo oops >&2; exit 2'), repo(), live)
    expect(r.exitCode).toBe(2)
    expect(reproduced(r)).toBe(false)
  })

  test('exiting 0 counts as corrected', async () => {
    const r = await runRepro(script('exit 0'), repo(), live)
    expect(corrected(r)).toBe(true)
    expect(reproduced(r)).toBe(false)
  })

  test('the repro files are written in the copy and the command sees them', async () => {
    const r = await runRepro(script('cat r/x.txt; exit 1', { marker: 'inside', files: [{ path: 'r/x.txt', content: 'inside' }] }), repo(), live)
    expect(reproduced(r)).toBe(true)
  })

  test('the working copy is unchanged and the throwaway copy is gone', async () => {
    const dir = repo()
    const root = tmp()
    const before = { status: status(dir), hash: hash(join(dir, 'a.txt')) }
    const r = await runRepro(
      script('echo MARK-1; echo changed > a.txt; exit 1', { files: [{ path: 'new/r.js', content: 'x' }] }),
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
    const r = await runRepro(script('echo MARK-1; sleep 60'), repo(), live, { timeoutMs: 400, root })
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
    const r = await runRepro(script('yes noise | head -c 200000; echo; echo MARK-1; exit 1'), repo(), live)
    expect(r.outputTail.length).toBeLessThanOrEqual(REPRO_TAIL_CHARS)
    expect(reproduced(r)).toBe(true)
  })

  test('a symlinked folder in the tree does not let a file land outside the copy', async () => {
    const dir = repo()
    const outside = tmp()
    symlinkSync(outside, join(dir, 'link'))
    const root = tmp()
    const r = await runRepro(script('echo MARK-1; exit 1', { files: [{ path: 'link/evil.txt', content: 'x' }] }), dir, live, { root })
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
    const r = await runRepro(script('echo MARK-1 > ../ran; exit 1', { files: [{ path: '../x', content: 'x' }] }), repo(), live, { root })
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
})

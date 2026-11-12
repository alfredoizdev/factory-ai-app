import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { ulid } from 'ulid'
import { cloneTree } from '@/engine/base'
import { runTestCommand, stripAnsi } from '@/engine/test-runner'

export type Repro = { command: string; marker: string; files: { path: string; content: string }[] }
export type ReproRun = { exitCode: number | null; markerSeen: boolean; outputTail: string; at: string }

// A reproduction is a small script an agent proposed to show that a reported problem is real. The app runs it
// itself, in a throwaway copy of the working copy, so what it records came from a process, not from the model.
// Everything the verifier returns is untrusted: it is checked here before anything is written or run.

export const MAX_REPRO_FILES = 5
export const MAX_REPRO_BYTES = 64 * 1024
export const REPRO_TIMEOUT_MS = 120_000
/** How long after the timeout the run may still hold things up before it is given up on. */
export const REPRO_GRACE_MS = 2_000
/** A marker shorter than this is too easy to meet by accident. */
export const MIN_MARKER_CHARS = 8
/** What is kept of a script's output. A noisy script must not bloat the database. */
export const REPRO_TAIL_CHARS = 2000

/** Where throwaway copies live: the app's own ignored data folder, never inside the task's working copy. */
export const VERIFY_ROOT = join(process.cwd(), '.factory', 'verify')

/** A path inside the copy: relative, no ".." (with / or \), no empty or NUL path, and no ".git" anywhere in it. */
export function safeReproPath(path: string): boolean {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return false
  const normal = path.replaceAll('\\', '/')
  if (normal.startsWith('/') || /^[A-Za-z]:/.test(normal)) return false
  return normal.split('/').every(seg => seg !== '' && seg !== '..' && seg.toLowerCase() !== '.git')
}

/** Every complete JSON object in the text that mentions `key`, last first. */
function objectsWith(text: string, key: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1))
        if (value && typeof value === 'object' && !Array.isArray(value) && key in value) {
          found.push(value as Record<string, unknown>)
          start = end
        }
        break
      } catch {
        // not this ending
      }
    }
  }
  return found.reverse()
}

export type VerifierAnswer = { reproduced: boolean; refuted?: { why: string } }

/** What the verifier concluded, from the last JSON object in its answer: reproduced, or refuted with a reason. */
export function parseVerifierAnswer(text: string): VerifierAnswer | null {
  for (const o of objectsWith(text, 'reproduced')) {
    if (typeof o.reproduced !== 'boolean') continue
    if (o.reproduced) return { reproduced: true }
    const why = typeof o.why === 'string' ? o.why.trim().slice(0, 500) : ''
    return o.refuted === true && why ? { reproduced: false, refuted: { why } } : { reproduced: false }
  }
  return null
}

/**
 * The reproduction in the verifier's answer, or null. `readFile` returns a named file's content from the verifier's
 * copy, or null when it is missing or unreadable. One bad path, one missing file or one limit passed: no repro at all.
 */
export function parseRepro(text: string, readFile: (path: string) => string | null): Repro | null {
  for (const o of objectsWith(text, 'reproduced')) {
    if (o.reproduced !== true) return null
    const { command, marker, files: named } = o
    if (typeof command !== 'string' || command.trim() === '' || typeof marker !== 'string') return null
    // The marker proves the script itself reached the failing point: a line only it prints, which no error message
    // that merely quotes the command can contain.
    if (marker.length < MIN_MARKER_CHARS || /[\r\n]/.test(marker) || command.includes(marker)) return null
    if (!Array.isArray(named) || named.length > MAX_REPRO_FILES) return null
    if (!named.every((p): p is string => typeof p === 'string' && safeReproPath(p))) return null
    const files: Repro['files'] = []
    let bytes = 0
    for (const path of named) {
      const content = readFile(path)
      if (content === null) return null
      bytes += Buffer.byteLength(content)
      if (bytes > MAX_REPRO_BYTES) return null
      files.push({ path, content })
    }
    return { command, marker, files }
  }
  return null
}

/** The environment for git inside a copy: nothing inherited may point it back at the real task, and it never looks above the copy. */
function copyGitEnv(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete env[k]
  // The person's own git settings (hooks, signing, templates) are not for a throwaway copy.
  return { ...env, GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

/** Removes a throwaway copy. Never throws: a stray process still writing into it must not turn a result into a crash. */
export function removeCopy(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // left behind; nothing useful can be done about it here
  }
}

/** Removes every `.git` file (a pointer to some repository's data) below `dir`; real `.git` folders are self-contained. */
function removeGitPointers(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') removeGitPointers(path)
    } else if (entry.isFile() && entry.name === '.git') {
      rmSync(path, { force: true })
    }
  }
}

/**
 * A fresh throwaway copy of the working copy, in `root`. The caller removes it. A task's working copy is a git
 * worktree whose `.git` file leads to the real repository's data, so the copy's `.git` is replaced by a repository of
 * its own, and any nested `.git` pointer file (a submodule, a nested worktree) is dropped: nothing a repro runs with
 * git can reach the real task. If that cannot be done no copy is handed out.
 */
export async function makeCopy(workdir: string, root: string = VERIFY_ROOT): Promise<string> {
  const copy = join(root, ulid())
  mkdirSync(root, { recursive: true })
  try {
    cloneTree(workdir, copy)
    rmSync(join(copy, '.git'), { recursive: true, force: true })
    removeGitPointers(copy)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: copy, env: copyGitEnv(root), stdio: 'ignore', timeout: 120_000 })
    git('init', '-q', '--template=')
    git('add', '-A')
    git(
      '-c', 'user.name=factory', '-c', 'user.email=factory@local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
      'commit', '-qm', 'base', '--no-verify', '--allow-empty',
    )
  } catch (e) {
    removeCopy(copy)
    throw e
  }
  return copy
}

/**
 * Writes one file into the copy without ever leaving it: every folder on the way is checked with lstat, so a
 * symlinked folder (or file) in the tree cannot send the write somewhere else.
 */
function writeInside(copy: string, path: string, content: string): boolean {
  if (!safeReproPath(path)) return false
  const segments = path.replaceAll('\\', '/').split('/')
  let here = copy
  for (const [i, seg] of segments.entries()) {
    here = join(here, seg)
    const last = i === segments.length - 1
    let info: ReturnType<typeof lstatSync> | null = null
    try {
      info = lstatSync(here)
    } catch {
      info = null
    }
    if (info?.isSymbolicLink()) return false
    if (!last) {
      if (!info) mkdirSync(here)
      else if (!info.isDirectory()) return false
    } else if (info && !info.isFile()) return false
  }
  const real = realpathSync(dirname(here))
  const root = realpathSync(copy)
  if (real !== root && !real.startsWith(`${root}${sep}`)) return false
  writeFileSync(here, content)
  return true
}

export type RunOptions = { timeoutMs?: number; graceMs?: number; root?: string }

/**
 * Runs the repro in its own copy of `workdir` and removes the copy. `workdir` is never written to. When a file
 * cannot be written safely nothing is run and the result counts as not reproduced.
 */
export async function runRepro(repro: Repro, workdir: string, signal: AbortSignal, options: RunOptions = {}): Promise<ReproRun> {
  const at = new Date().toISOString()
  const notRun: ReproRun = { exitCode: null, markerSeen: false, outputTail: '', at }
  if (signal.aborted) return notRun
  const root = options.root ?? VERIFY_ROOT
  const timeoutMs = options.timeoutMs ?? REPRO_TIMEOUT_MS
  const graceMs = options.graceMs ?? REPRO_GRACE_MS
  let copy: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    copy = await makeCopy(workdir, options.root)
    for (const f of repro.files) {
      if (!writeInside(copy, f.path, f.content)) return notRun
    }
    const giveUp = new AbortController()
    const stopAt = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs), giveUp.signal])
    const running = runTestCommand(repro.command, copy, stopAt, { GIT_CEILING_DIRECTORIES: root })
    // runTestCommand answers when every holder of the output pipes lets go, and a process that left its group can
    // hold them for as long as it likes. The deadline does not wait for it.
    const deadline = new Promise<null>(resolve => {
      const expire = () => {
        giveUp.abort()
        resolve(null)
      }
      timer = setTimeout(expire, timeoutMs + graceMs)
      onAbort = () => {
        clearTimeout(timer)
        timer = setTimeout(expire, graceMs)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const run = await Promise.race([running, deadline])
    if (!run) return notRun
    const lines = stripAnsi(run.outputTail).split(/\r?\n/)
    return {
      exitCode: run.exitCode,
      // Only a line that is the marker and nothing else: an error message that quotes the command does not count.
      markerSeen: repro.marker !== '' && lines.some(l => l.trim() === repro.marker),
      outputTail: run.outputTail.slice(-REPRO_TAIL_CHARS),
      at,
    }
  } catch {
    return notRun
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
    if (copy) removeCopy(copy)
  }
}

export const reproduced = (r: ReproRun): boolean => r.exitCode !== 0 && r.exitCode !== null && r.markerSeen
export const corrected = (r: ReproRun): boolean => r.exitCode === 0

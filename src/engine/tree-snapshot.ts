import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { SECRET_FILES } from '@/engine/risk'

// A snapshot of the task's folder taken before a fix, so a fix can be checked against it and taken back.
//
// Where it lives: a snapshot is a git tree object (tracked and untracked files that are not ignored). It is made with a
// temporary index file and written into the APP's own object store (`<cwd>/.factory/snapshots/<hash of the folder>/objects`,
// or `options.store`), with the repository's own objects only read through git's "alternates". Nothing is written into the
// person's repository: their `git gc` cannot remove a snapshot, nothing can leak through a push, no refs are made, and the
// real index, HEAD and stash are never touched.
//
// Taking a fix back is scoped: `undoChange` only reverts the paths the fix changed, and only those still as the fix left
// them; anything the person changed since is left alone and reported. Ignored files (node_modules, .env, build output) are
// never deleted or overwritten, judged by the rules the snapshot had, not the ones a fixer may have rewritten. The few
// ignored files whose names look sensitive (secrets, sign-in) are recorded and compared too, because a fix there matters.
//
// Not watched: private files inside generated-output folders (dist, build, out, .next, ...), and beyond the 50-file / 1 MB limits.
// Not covered: nested repositories and submodules. A fix inside one is neither detected nor undone. Empty folders are
// never removed. Every git call uses an argument list, never a shell.

/** How many times one problem is fixed before it is given up on. */
export const MAX_FIX_ATTEMPTS = 2
/** Ignored sensitive files recorded per snapshot, and the largest one recorded. */
export const MAX_IGNORED_FILES = 50
export const MAX_IGNORED_BYTES = 1024 * 1024

export type Options = { store?: string }
export type IgnoredFile = { path: string; mode: string; blob: string }
/** A tree, and the ignored sensitive files (with their contents in the app's store) as they were with it. `skipped`: how many were over the limits. */
export type Snap = { tree: string; ignored: IgnoredFile[]; skipped: number }
export type Undone = { reverted: string[]; kept: string[]; failed: string[] }

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function checkId(id: string, what: string): void {
  if (typeof id !== 'string' || !OBJECT_ID.test(id)) throw new Error(`Not a git object id: ${what}`)
}

/** Where this folder's snapshots live. */
function storeOf(workdir: string, options: Options): string {
  if (options.store) return resolve(options.store)
  const key = createHash('sha256').update(realpathSync(workdir)).digest('hex').slice(0, 16)
  return join(process.cwd(), '.factory', 'snapshots', key)
}

/** The environment for git here: nothing inherited may point it at another repository or index; new objects go to the app's store and the repository's own are read through alternates. */
function gitEnv(workdir: string, options: Options, indexFile?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[k]
  const real = execFileSync('git', ['rev-parse', '--git-path', 'objects'], { cwd: workdir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const objects = join(storeOf(workdir, options), 'objects')
  mkdirSync(objects, { recursive: true })
  return {
    ...env,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: isAbsolute(real) ? real : resolve(workdir, real),
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  }
}

function git(workdir: string, options: Options, args: string[], extra: { index?: string; input?: string | Buffer } = {}): string {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: workdir,
    env: gitEnv(workdir, options, extra.index),
    encoding: 'utf8',
    input: extra.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  })
}

function gitBuffer(workdir: string, options: Options, args: string[]): Buffer {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: workdir, env: gitEnv(workdir, options), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
}

/** Refuses a folder that is not itself the top of a working copy: a plain folder inside some other repository must not snapshot that one. */
function checkRoot(workdir: string, options: Options): void {
  const top = git(workdir, options, ['rev-parse', '--show-toplevel']).trim()
  if (realpathSync(top) !== realpathSync(workdir)) throw new Error('The folder is not a working copy of its own')
}

function withTempIndex<T>(fn: (indexFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'factory-index-'))
  try {
    return fn(join(dir, 'index'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A git tree id of the tracked and untracked files that are not ignored, as they are now. */
export function snapshotTree(workdir: string, options: Options = {}): string {
  checkRoot(workdir, options)
  return withTempIndex(index => {
    // Start from what HEAD tracks, so a tracked file that happens to match .gitignore is still in the snapshot; a new repository has no HEAD yet.
    let hasHead = true
    try {
      git(workdir, options, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
    } catch {
      hasHead = false
    }
    if (hasHead) git(workdir, options, ['read-tree', 'HEAD'], { index })
    git(workdir, options, ['add', '-A', '--', '.'], { index })
    return git(workdir, options, ['write-tree'], { index }).trim()
  })
}

const modeOf = (executable: boolean) => (executable ? '100755' : '100644')

/** Folders of generated output, at any depth: what a build or a test run writes there is not a private file. */
const OUTPUT_FOLDERS = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache', '.vercel', '.git'])

/** The ignored private settings files (.env and the like), with their contents kept in the app's store. Over the limits: skipped and counted. */
function ignoredSensitive(workdir: string, options: Options): { files: IgnoredFile[]; skipped: number } {
  const listed = git(workdir, options, ['ls-files', '-o', '-i', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const sensitive = listed.filter(p => !p.split('/').some(seg => OUTPUT_FOLDERS.has(seg)) && SECRET_FILES.test(p))
  const files: IgnoredFile[] = []
  let skipped = 0
  for (const path of sensitive) {
    try {
      const info = lstatSync(join(workdir, path))
      if (files.length >= MAX_IGNORED_FILES || !info.isFile() || info.size > MAX_IGNORED_BYTES) {
        skipped++
        continue
      }
      files.push({ path, mode: modeOf((info.mode & 0o111) !== 0), blob: git(workdir, options, ['hash-object', '-w', '--', path]).trim() })
    } catch {
      skipped++
    }
  }
  return { files: files.sort((a, b) => (a.path < b.path ? -1 : 1)), skipped }
}

/** The tree, and the ignored sensitive files, as they are now. */
export function takeSnap(workdir: string, options: Options = {}): Snap {
  const tree = snapshotTree(workdir, options)
  const { files, skipped } = ignoredSensitive(workdir, options)
  return { tree, ignored: files, skipped }
}

type Entry = { mode: string; sha: string }
const key = (e: Entry | null): string => (e ? `${e.mode} ${e.sha}` : '-')

/** What differs between two trees (or a commit and a tree): git's status letter and the path, no renames. */
function diff(workdir: string, options: Options, from: string, to: string): { status: string; path: string }[] {
  const parts = git(workdir, options, ['diff-tree', '-r', '-z', '--name-status', '--no-renames', from, to]).split('\0')
  const out: { status: string; path: string }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i]!, path: parts[i + 1]! })
  return out
}

/** The paths that differ between a commit (or tree) and a tree, sorted. */
export function changedBetween(workdir: string, from: string, tree: string, options: Options = {}): string[] {
  checkId(from, 'from')
  checkId(tree, 'tree')
  return diff(workdir, options, from, tree).map(c => c.path).sort()
}

/** The paths whose contents differ between the snapshot and the folder now, sorted. */
export function changedSince(workdir: string, tree: string, options: Options = {}): string[] {
  checkId(tree, 'tree')
  return changedBetween(workdir, tree, snapshotTree(workdir, options), options)
}

const asSnap = (s: Snap | string): Snap => (typeof s === 'string' ? { tree: s, ignored: [], skipped: 0 } : s)

/** What a fix changed: the paths that differ between the two snapshots, ignored sensitive files included. Sorted. */
export function changedPaths(workdir: string, before: Snap | string, after: Snap | string, options: Options = {}): string[] {
  const a = asSnap(before)
  const b = asSnap(after)
  checkId(a.tree, 'before')
  checkId(b.tree, 'after')
  const out = new Set(diff(workdir, options, a.tree, b.tree).map(c => c.path))
  const ignoredEntry = (s: Snap) => new Map(s.ignored.map(f => [f.path, key({ mode: f.mode, sha: f.blob })]))
  const x = ignoredEntry(a)
  const y = ignoredEntry(b)
  for (const p of new Set([...x.keys(), ...y.keys()])) if (x.get(p) !== y.get(p)) out.add(p)
  return [...out].sort()
}

/** The entries a tree has at the given paths. */
function entriesIn(workdir: string, options: Options, tree: string, paths: string[]): Map<string, Entry> {
  const found = new Map<string, Entry>()
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100)
    const out = git(workdir, options, ['ls-tree', '-r', '-z', tree, '--', ...chunk]).split('\0').filter(Boolean)
    for (const line of out) {
      const tab = line.indexOf('\t')
      const [mode, type, sha] = line.slice(0, tab).split(' ')
      if (type === 'blob' && chunk.includes(line.slice(tab + 1))) found.set(line.slice(tab + 1), { mode: mode!, sha: sha! })
    }
  }
  return found
}

/** What is at a path now, read directly: its content hashed without writing anything. A non-empty folder counts as something that is not a file. */
function currentEntry(workdir: string, options: Options, path: string): Entry | null {
  const full = join(workdir, path)
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(full)
  } catch {
    return null
  }
  if (info.isSymbolicLink()) return { mode: '120000', sha: git(workdir, options, ['hash-object', '--stdin'], { input: readlinkSync(full) }).trim() }
  if (info.isDirectory()) return readdirSync(full).length === 0 ? null : { mode: '040000', sha: 'folder' }
  return { mode: modeOf((info.mode & 0o111) !== 0), sha: git(workdir, options, ['hash-object', '--', path]).trim() }
}

const insideFolder = (path: string): boolean => path !== '' && !path.startsWith('/') && path.split('/').every(seg => seg !== '' && seg !== '..' && seg !== '.git')

/** Whether any folder on the way to the path is a symlink (a write or removal there could leave the working copy). */
function viaSymlink(workdir: string, path: string): boolean {
  const segments = path.split('/')
  let here = workdir
  for (const seg of segments.slice(0, -1)) {
    here = join(here, seg)
    try {
      if (lstatSync(here).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

function isIgnored(workdir: string, options: Options, path: string): boolean {
  try {
    git(workdir, options, ['check-ignore', '-q', '--', path])
    return true
  } catch {
    return false
  }
}

function putBack(workdir: string, options: Options, path: string, entry: Entry): void {
  const full = join(workdir, path)
  // A file is written the way git would check it out here (line endings, smudge filters, large-file pointers); a link keeps the stored target.
  const content = entry.mode === '120000' ? gitBuffer(workdir, options, ['cat-file', 'blob', entry.sha]) : gitBuffer(workdir, options, ['cat-file', '--filters', `--path=${path}`, entry.sha])
  // A folder on the way that is really a file: the path cannot be put back without destroying that file.
  const segments = path.split('/')
  let here = workdir
  for (const seg of segments.slice(0, -1)) {
    here = join(here, seg)
    if (!existsSync(here)) mkdirSync(here)
    else if (!lstatSync(here).isDirectory()) throw new Error('A file is in the way')
  }
  if (existsSync(full) || isLink(full)) {
    if (lstatSync(full).isDirectory()) rmdirSync(full)
    else rmSync(full, { force: true })
  }
  if (entry.mode === '120000') symlinkSync(content.toString(), full)
  else {
    writeFileSync(full, content)
    chmodSync(full, entry.mode === '100755' ? 0o755 : 0o644)
  }
}

function isLink(full: string): boolean {
  try {
    return lstatSync(full).isSymbolicLink()
  } catch {
    return false
  }
}

const isIgnoreConfig = (path: string): boolean => /(^|\/)\.(gitignore|gitattributes)$/.test(path)

/**
 * Takes back what a fix did, and nothing else. For each path that differs between `before` and `after`: if it is still
 * as `after` has it (same content and mode, or absent in both) it is put back to what `before` has (or removed, when
 * `before` had none); otherwise someone changed it since and it is left alone and listed in `kept`. Paths the fix did not
 * change are never touched. Ignore rules the fix changed are put back first; a path is never removed if the restored
 * rules ignore it (except the recorded sensitive ignored files, which are the fix's to answer for). A path that cannot
 * be handled is listed in `failed` and does not stop the others. Works path by path: it never needs a fresh full snapshot.
 */
export function undoChange(workdir: string, beforeIn: Snap | string, afterIn: Snap | string, options: Options = {}): Undone {
  const before = asSnap(beforeIn)
  const after = asSnap(afterIn)
  checkId(before.tree, 'before')
  checkId(after.tree, 'after')
  const candidates = changedPaths(workdir, before, after, options)
  const recorded = new Set([...before.ignored, ...after.ignored].map(f => f.path))
  const inTree = (tree: string) => entriesIn(workdir, options, tree, candidates)
  const treeBefore = inTree(before.tree)
  const treeAfter = inTree(after.tree)
  const pick = (snap: Snap, tree: Map<string, Entry>, path: string): Entry | null => {
    const hit = tree.get(path)
    if (hit) return hit
    const f = snap.ignored.find(i => i.path === path)
    return f ? { mode: f.mode, sha: f.blob } : null
  }
  const done: Undone = { reverted: [], kept: [], failed: [] }
  let rulesLost = false
  const handle = (path: string) => {
    try {
      if (!insideFolder(path) || viaSymlink(workdir, path)) throw new Error('Not a path to touch')
      const wanted = pick(before, treeBefore, path)
      const left = pick(after, treeAfter, path)
      if (key(wanted) === key(left)) return
      const now = currentEntry(workdir, options, path)
      // Already as it was before the fix (an undo that ran before): done.
      if (key(now) === key(wanted)) {
        done.reverted.push(path)
        return
      }
      if (key(now) !== key(left)) {
        done.kept.push(path)
        return
      }
      if (wanted === null) {
        if (!recorded.has(path)) {
          // The ignore rules on disk are not the snapshot's when the fix changed them and they could not be put back: remove nothing that was not there before.
          if (rulesLost) {
            done.kept.push(path)
            return
          }
          if (isIgnored(workdir, options, path)) return
        }
        rmSync(join(workdir, path), { force: true })
      } else {
        putBack(workdir, options, path, wanted)
      }
      done.reverted.push(path)
    } catch {
      done.failed.push(path)
    }
  }
  // The ignore rules first, so that what is removed afterwards is judged by the snapshot's rules.
  // Removals before writes, so a folder the fix made where a file was is gone before the file comes back.
  const removal = (p: string) => pick(before, treeBefore, p) === null
  const ordered = [...candidates.filter(isIgnoreConfig), ...candidates.filter(c => !isIgnoreConfig(c) && removal(c)), ...candidates.filter(c => !isIgnoreConfig(c) && !removal(c))]
  for (const p of ordered.filter(isIgnoreConfig)) handle(p)
  rulesLost = [...done.kept, ...done.failed].some(isIgnoreConfig)
  for (const p of ordered.filter(c => !isIgnoreConfig(c))) handle(p)
  return { reverted: done.reverted.sort(), kept: done.kept.sort(), failed: done.failed.sort() }
}

/**
 * Makes the folder's tracked and untracked-unignored contents equal the snapshot, taking everything back, including
 * what the person changed since. Only for the one window where a fixer died while it was running and no record of what
 * it did exists. Ignored files and the real index are left alone.
 */
export function restoreTree(workdir: string, tree: string, options: Options = {}): void {
  checkId(tree, 'tree')
  const result = undoChange(workdir, tree, snapshotTree(workdir, options), options)
  if (result.failed.length > 0) throw new Error(`Could not put back: ${result.failed.join(', ')}`)
}

const attemptsDir = (workdir: string, options: Options) => join(storeOf(workdir, options), 'attempts')

/**
 * Called as a fixer attempt starts. The first time it takes a full snapshot of the folder as it is right then (the tree and
 * the private files) and remembers it under the name; every undo and every measure of that attempt is against it. Called
 * again with the same name (the step ran before and its result was lost) it says so and hands back that start: what a
 * half-finished fixer left is taken back to it, and nothing from before the attempt began. A marker that cannot be read gives
 * `start: null`: the caller treats the attempt as failed and restores nothing.
 */
export function startAttempt(workdir: string, name: string, options: Options = {}): { again: false; start: Snap } | { again: true; start: Snap | null } {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Not a name to claim')
  const dir = attemptsDir(workdir, options)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  const seen = (): { again: true; start: Snap | null } => {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Snap>
      const ok = typeof v.tree === 'string' && OBJECT_ID.test(v.tree) && Array.isArray(v.ignored) && v.ignored.every(f => f && typeof f.path === 'string' && typeof f.mode === 'string' && typeof f.blob === 'string' && OBJECT_ID.test(f.blob))
      return { again: true, start: ok ? { tree: v.tree!, ignored: v.ignored!, skipped: typeof v.skipped === 'number' ? v.skipped : 0 } : null }
    } catch {
      return { again: true, start: null }
    }
  }
  if (existsSync(file)) return seen()
  const start = takeSnap(workdir, options)
  try {
    writeFileSync(file, JSON.stringify(start), { flag: 'wx' })
  } catch {
    return seen()
  }
  return { again: false, start }
}

/** Forgets the attempts of one finding (their names start with its id) once it has an ending. */
export function releaseAttempts(workdir: string, prefix: string, options: Options = {}): void {
  const dir = attemptsDir(workdir, options)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) if (name.startsWith(`${prefix}-`)) rmSync(join(dir, name), { force: true })
}

/**
 * The paths that differ from a snapshot, found path by path from what git says is dirty and from the recorded private
 * files, with no new snapshot: it works where a snapshot cannot be taken. May miss a path a fix put back as the repository has it.
 */
export function looseChanges(workdir: string, snap: Snap, options: Options = {}): string[] {
  const parts = git(workdir, options, ['status', '--porcelain=v1', '-z', '-uall']).split('\0').filter(Boolean)
  const candidates = new Set(snap.ignored.map(f => f.path))
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!.slice(0, 2)
    candidates.add(parts[i]!.slice(3).replace(/\/$/, ''))
    if (code[0] === 'R' || code[0] === 'C') i++ // the old name follows
  }
  const paths = [...candidates].filter(insideFolder)
  const tree = entriesIn(workdir, options, snap.tree, paths)
  return paths
    .filter(p => {
      const was = tree.get(p) ?? (snap.ignored.find(f => f.path === p) ? { mode: snap.ignored.find(f => f.path === p)!.mode, sha: snap.ignored.find(f => f.path === p)!.blob } : null)
      return key(was) !== key(currentEntry(workdir, options, p))
    })
    .sort()
}

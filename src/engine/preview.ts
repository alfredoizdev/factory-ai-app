import { projectEnv } from '@/engine/child-env'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects, runs } from '@/db/schema'
import { clip, redact } from '@/engine/redact'
import { stripAnsi } from '@/engine/test-runner'
import { strings } from '@/ui/strings'
import { projectHere, setLocal } from '@/engine/machine'
import { elsewhere } from '@/engine/machine'

// A live preview of a run's change: the project's own dev server, started from the run's worktree, on this
// computer only. It runs the project's `dev` script and nothing else — the request cannot choose the command — with
// the project's untracked env files copied into the worktree so it behaves like the person's own copy. It is not a
// sandbox: it is the person's own code, run the way they run it, from a separate folder.

export type PreviewStatus = 'installing' | 'starting' | 'ready' | 'failed' | 'stopped'
export type PreviewState = { status: PreviewStatus; url: string | null; message: string | null; log: string }

type Entry = PreviewState & { child: ChildProcess | null; port: number | null }

// Kept on globalThis so a dev-server hot reload of this module does not forget previews that are running.
const registry: Map<string, Entry> = ((globalThis as { __factoryPreviews?: Map<string, Entry> }).__factoryPreviews ??= new Map())

const FIRST_PORT = 4200
const READY_TIMEOUT_MS = 180_000
const LOG_CHARS = 4000
const GRACE_MS = 3000

export type DevCommand = { argv: string[]; installArgv: string[] | null }

/** How to start this project's dev server on a given port, from its package.json and lockfile; null without one. */
export function devCommand(dir: string, port: number): DevCommand | null {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (!pkg.scripts?.dev) return null
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const has = (f: string) => existsSync(join(dir, f))
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
  const run = pm === 'npm' ? ['npm', 'run', 'dev', '--'] : pm === 'yarn' ? ['yarn', 'dev'] : [pm, 'run', 'dev']
  const p = String(port)
  // Port and host passed the way each framework reads them; PORT/HOST are also set in the environment for the rest.
  const flags = deps.next ? ['-p', p, '-H', '127.0.0.1'] : deps.vite ? ['--port', p, '--host', '127.0.0.1', '--strictPort'] : []
  return { argv: [...run, ...flags], installArgv: has('node_modules') ? null : [pm, 'install'] }
}

/** Copies the project's untracked env files (.env, .env.local, …) into the worktree, never overwriting one there. */
export function copyEnvFiles(fromRepo: string, toWorktree: string): string[] {
  const copied: string[] = []
  for (const name of readdirSync(fromRepo)) {
    if (!/^\.env(\..+)?$/.test(name) || /\.example$|\.sample$|\.template$/.test(name)) continue
    if (existsSync(join(toWorktree, name))) continue
    copyFileSync(join(fromRepo, name), join(toWorktree, name))
    copied.push(name)
  }
  return copied
}

/** A port given to a server that has not opened it yet still counts as taken: two versions started at the same
 *  moment (the site before a change and after it) must not be handed the same one. */
const promised = (port: number) => [...registry.values()].some(e => e.port === port && e.status !== 'failed' && e.status !== 'stopped')
let picking: Promise<unknown> = Promise.resolve()

/** The next free port from `start`. One caller at a time, so each sees the port the one before it was given. */
function freePort(start: number): Promise<number> {
  const mine = picking.then(
    () =>
      new Promise<number>((resolve, reject) => {
        const tryPort = (port: number) => {
          if (port > start + 200) return reject(new Error('no free port'))
          const server = createServer()
          server.once('error', () => tryPort(port + 1))
          server.listen(port, '127.0.0.1', () => server.close(() => (promised(port) ? tryPort(port + 1) : resolve(port))))
        }
        tryPort(start)
      }),
  )
  // The next caller waits one more turn, so this one has written its port down by then.
  picking = mine.then(
    () => new Promise(r => setTimeout(r, 0)),
    () => undefined,
  )
  return mine
}

// The preview's environment: the person's, minus this app's own framework and Inngest settings, which would
// otherwise leak into another Next.js or Inngest app and point it at this one.
function previewEnv(port: number): NodeJS.ProcessEnv {
  // NODE_ENV is set back to what a dev server expects: this app's own value must not leak in.
  return projectEnv({ NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', BROWSER: 'none' })
}

function keepLog(entry: Entry, chunk: Buffer) {
  entry.log = clip(redact(stripAnsi(entry.log + chunk.toString())).slice(-LOG_CHARS), LOG_CHARS)
}

function runToEnd(argv: string[], cwd: string, env: NodeJS.ProcessEnv, entry: Entry): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    entry.child = child
    child.stdout?.on('data', c => keepLog(entry, c))
    child.stderr?.on('data', c => keepLog(entry, c))
    child.once('error', () => resolve(null))
    child.once('close', code => resolve(code))
  })
}

async function waitUntilServing(url: string, entry: Entry): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (entry.status !== 'starting') return false
    if (entry.child && entry.child.exitCode !== null) return false
    try {
      await fetch(url, { signal: AbortSignal.timeout(3000) })
      return true // any answer at all means the server is up; the page itself is the person's to judge
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  return false
}

function signalGroup(child: ChildProcess | null, sig: NodeJS.Signals) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, sig)
  } catch {
    // already gone
  }
}

export function previewState(key: string): PreviewState {
  const e = registry.get(key)
  return e ? { status: e.status, url: e.url, message: e.message, log: e.log } : { status: 'stopped', url: null, message: null, log: '' }
}

/** Starts the preview for a run, or returns the one already running. Resolves once it is starting; poll for ready. */
export async function startPreview(runId: string): Promise<PreviewState> {
  const away = await elsewhere(runId)
  if (away) throw new PreviewError(away)
  const existing = registry.get(runId)
  if (existing && existing.status !== 'failed' && existing.status !== 'stopped') return previewState(runId)

  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run?.worktreePath || !existsSync(run.worktreePath)) throw new PreviewError(strings.preview.noWorktree)
  const project = await projectHere(run.projectId)
  return startServer(runId, run.worktreePath, project?.repoPath ?? null)
}

/**
 * Starts the project's dev server from `dir`, under `key` (a run's id, or any other name for another copy, such as
 * the version before a change). Resolves once it is starting; poll previewState(key) for ready.
 */
export async function startServer(key: string, dir: string, repoPath: string | null): Promise<PreviewState> {
  const existing = registry.get(key)
  if (existing && existing.status !== 'failed' && existing.status !== 'stopped') return previewState(key)
  const port = await freePort(FIRST_PORT)
  const cmd = devCommand(dir, port)
  if (!cmd) throw new PreviewError(strings.preview.noDevScript)

  const entry: Entry = { status: cmd.installArgv ? 'installing' : 'starting', url: null, message: null, log: '', child: null, port }
  registry.set(key, entry)
  if (repoPath) copyEnvFiles(repoPath, dir)
  const env = previewEnv(port)
  const cwd = dir

  void (async () => {
    if (cmd.installArgv) {
      const code = await runToEnd(cmd.installArgv, cwd, env, entry)
      if (entry.status === 'stopped') return
      if (code !== 0) {
        entry.status = 'failed'
        entry.message = strings.preview.installFailed
        return
      }
      entry.status = 'starting'
    }
    const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    entry.child = child
    child.stdout?.on('data', c => keepLog(entry, c))
    child.stderr?.on('data', c => keepLog(entry, c))
    child.once('close', () => {
      if (entry.status === 'starting' || entry.status === 'ready') {
        entry.status = 'failed'
        entry.message = strings.preview.exited
      }
    })
    const url = `http://127.0.0.1:${port}/`
    if (await waitUntilServing(url, entry)) {
      entry.status = 'ready'
      entry.url = url
    } else if (entry.status === 'starting') {
      entry.status = 'failed'
      entry.message = strings.preview.neverServed
      signalGroup(child, 'SIGTERM')
    }
  })()
  return previewState(key)
}

/** Waits until the server under `key` is ready (its address) or has failed or stopped (null). */
export async function untilReady(key: string, timeoutMs = READY_TIMEOUT_MS + 120_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = previewState(key)
    if (state.status === 'ready') return state.url
    if (state.status === 'failed' || state.status === 'stopped') return null
    await new Promise(r => setTimeout(r, 1000))
  }
  return null
}

/** Stops a run's preview and everything it started. Harmless when none is running. */
export function stopPreview(key: string): void {
  const e = registry.get(key)
  if (!e) return
  e.status = 'stopped'
  e.url = null
  const child = e.child
  signalGroup(child, 'SIGTERM')
  setTimeout(() => signalGroup(child, 'SIGKILL'), GRACE_MS).unref()
}

export class PreviewError extends Error {}

// When this app stops, its previews stop with it rather than outliving it on ports nobody remembers.
const g = globalThis as { __factoryPreviewExitHook?: boolean }
if (!g.__factoryPreviewExitHook) {
  g.__factoryPreviewExitHook = true
  process.once('exit', () => {
    for (const e of registry.values()) signalGroup(e.child, 'SIGKILL')
  })
}

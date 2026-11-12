import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, projects, runs } from '@/db/schema'
import { copyBaseInto } from '@/engine/base'
import { changedFiles, pendingDiff } from '@/engine/delivery'
import { appendEventSync } from '@/engine/events'
import { previewState, startPreview, startServer, stopPreview, untilReady } from '@/engine/preview'
import { clip, redact } from '@/engine/redact'
import { strings } from '@/ui/strings'
import { projectHere, setLocal } from '@/engine/machine'
import { elsewhere } from '@/engine/machine'
import { snapshotKey, storage } from '@/engine/storage'

// Before and after: pictures of the person's site as it was and with the change, taken by a real browser on this
// computer. Both versions are started with the project's own dev server — the change from the run's working copy, the
// version before it from a separate copy at the commit the run started from — and photographed at the same page, on a
// desktop and a phone screen. They are facts a browser saw, not a model's description, and they belong to the change
// they were taken of: once the change moves (a new round), they are out of date and taken again.

export const SNAP_ROOT = join(process.cwd(), '.factory', 'snapshots')
export const SHOTS = ['before-desktop', 'after-desktop', 'before-mobile', 'after-mobile'] as const
export type Shot = (typeof SHOTS)[number]
export type SnapshotState = {
  status: 'none' | 'working' | 'ready' | 'failed'
  /** The page photographed, such as "/". */
  route: string | null
  shots: Shot[]
  /** While working: what it is doing. Failed: why. */
  message: string | null
}

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const

export type Shoot = (url: string, files: { desktop: string; mobile: string }) => Promise<void>

/** Photographs `url` on a desktop and a phone screen with the Chromium that Playwright installed. */
export const playwrightShoot: Shoot = async (url, files) => {
  // Loaded only when pictures are taken, so nothing else in the app pulls a browser in.
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  try {
    for (const kind of ['desktop', 'mobile'] as const) {
      const context = await browser.newContext(VIEWPORTS[kind])
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'load', timeout: 120_000 })
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
      // Fonts, images and entrance animations settle.
      await page.waitForTimeout(1500)
      await page.screenshot({ path: files[kind] })
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

/** The page a change shows on, from the files it changed: the first app or pages route; the home page otherwise. */
export function routeFor(files: readonly string[]): string {
  for (const f of files) {
    const app = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(f)
    if (app) {
      const segments = (app[1] ?? '').split('/').filter(s => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
      if (segments.some(s => s.startsWith('['))) continue // a dynamic page has no one address to open
      return `/${segments.join('/')}`
    }
    const pages = /^(?:src\/)?pages\/(.*)\.(?:tsx|jsx|ts|js|mdx)$/.exec(f)
    if (pages && !/^(_|api\/)/.test(pages[1]!) && !pages[1]!.includes('[')) {
      return `/${pages[1]!.replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/'
    }
  }
  return '/'
}

const fileOf = (runId: string, shot: Shot, root = SNAP_ROOT) => join(root, runId, `${shot}.png`)
/** A picture's bytes, by its fixed name only: from this computer when it took it, otherwise from R2. */
export async function readSnapshot(runId: string, shot: string, root = SNAP_ROOT): Promise<Uint8Array | null> {
  if (!(SHOTS as readonly string[]).includes(shot)) return null
  const local = snapshotFile(runId, shot, root)
  if (local) return new Uint8Array(readFileSync(local))
  return (await storage()?.get(snapshotKey(runId, shot)))?.body ?? null
}

export const snapshotFile = (runId: string, shot: string, root = SNAP_ROOT): string | null =>
  (SHOTS as readonly string[]).includes(shot) && existsSync(fileOf(runId, shot as Shot, root)) ? fileOf(runId, shot as Shot, root) : null

const changeHash = async (runId: string) => createHash('sha256').update((await pendingDiff(runId))).digest('hex').slice(0, 16)

// Pictures being taken now, by run. Kept on globalThis so a hot reload does not forget them.
const working: Map<string, string> = ((globalThis as { __factorySnapshots?: Map<string, string> }).__factorySnapshots ??= new Map())

/** Where the pictures of a run's change stand. Pictures of an earlier version of the change do not count. */
export async function snapshotState(runId: string): Promise<SnapshotState> {
  const now = working.get(runId)
  if (now !== undefined) return { status: 'working', route: null, shots: [], message: now }
  const row = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.snapshots'))).orderBy(desc(events.sequence)))[0]
  if (!row) return { status: 'none', route: null, shots: [], message: null }
  const p = JSON.parse(row.payloadJson) as { route: string | null; shots: Shot[]; message: string | null; change: string }
  if (p.change !== (await changeHash(runId))) return { status: 'none', route: null, shots: [], message: null }
  // Pictures live in R2 when it is set up (any computer can show them), otherwise on the computer that took them.
  const shots = p.shots.filter(s => storage() !== null || snapshotFile(runId, s) !== null)
  return shots.length > 0 ? { status: 'ready', route: p.route, shots, message: null } : { status: 'failed', route: p.route, shots: [], message: p.message }
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * Takes the before and after pictures of a run's change, in the background. Returns at once; snapshotState says how
 * it goes. Once at a time per run. Whatever it started (the version before, a copy of it, a browser) it stops.
 */
export async function captureBeforeAfter(runId: string, shoot: Shoot = playwrightShoot, root = SNAP_ROOT): Promise<SnapshotState> {
  const away = await elsewhere(runId)
  if (away) throw new SnapshotError(away)
  if (working.has(runId)) return snapshotState(runId)
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run?.worktreePath || !existsSync(run.worktreePath)) throw new SnapshotError(strings.snapshots.noWorkingCopy)
  const project = await projectHere(run.projectId)
  const repo = project?.repoPath
  const from = run.deliveryBase ?? run.baseCommit
  if (!repo || !from) throw new SnapshotError(strings.snapshots.noWorkingCopy)

  const change = (await changeHash(runId))
  const route = routeFor((await changedFiles(runId)))
  const dir = join(root, runId)
  const beforeTree = join(dir, 'before-tree')
  const beforeKey = `${runId}:before`
  const afterWasRunning = ['starting', 'installing', 'ready'].includes(previewState(runId).status)
  working.set(runId, strings.snapshots.starting)

  void (async () => {
    const shots: Shot[] = []
    let message: string | null = null
    try {
      mkdirSync(dir, { recursive: true })
      if (existsSync(beforeTree)) removeTree(repo, beforeTree)
      git(repo, ['worktree', 'add', '-q', '--detach', beforeTree, from])
      await copyBaseInto(run.projectId, beforeTree)
      // Both versions start at once; each is photographed as soon as it answers.
      await Promise.all([startPreview(runId), startServer(beforeKey, beforeTree, repo)])
      working.set(runId, strings.snapshots.waiting)
      const [afterUrl, beforeUrl] = await Promise.all([untilReady(runId), untilReady(beforeKey)])
      working.set(runId, strings.snapshots.shooting)
      const page = (base: string) => new URL(route, base).toString()
      if (beforeUrl) {
        await shoot(page(beforeUrl), { desktop: fileOf(runId, 'before-desktop', root), mobile: fileOf(runId, 'before-mobile', root) })
        shots.push('before-desktop', 'before-mobile')
      }
      if (afterUrl) {
        await shoot(page(afterUrl), { desktop: fileOf(runId, 'after-desktop', root), mobile: fileOf(runId, 'after-mobile', root) })
        shots.push('after-desktop', 'after-mobile')
      }
      // Kept in R2 too, so another computer can show them.
      const store = storage()
      if (store) for (const shot of shots) await store.put(snapshotKey(runId, shot), readFileSync(fileOf(runId, shot, root)), 'image/png')
      if (!beforeUrl || !afterUrl) message = strings.snapshots.didNotStart(!afterUrl ? strings.snapshots.afterVersion : strings.snapshots.beforeVersion)
    } catch (e) {
      message = strings.snapshots.failed(clip(redact(String((e as Error)?.message ?? e)).split('\n')[0] ?? '', 200))
    } finally {
      stopPreview(beforeKey)
      if (!afterWasRunning) stopPreview(runId)
      // The dev server lets go of the copy first, then the copy goes.
      setTimeout(() => removeTree(repo, beforeTree), 4000).unref()
      try {
        await db.transaction(async tx => void (await appendEventSync({ runId, type: 'run.snapshots', payload: { route, shots, message, change } }, tx)))
      } finally {
        working.delete(runId)
      }
    }
  })()
  return snapshotState(runId)
}

function removeTree(repo: string, tree: string) {
  try {
    git(repo, ['worktree', 'remove', '--force', tree])
  } catch {
    rmSync(tree, { recursive: true, force: true })
    try {
      git(repo, ['worktree', 'prune'])
    } catch {
      // nothing left to prune
    }
  }
}

export class SnapshotError extends Error {}

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
import { devCommand, previewState, startPreview, startServer, stopPreview, untilReady } from '@/engine/preview'
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
  /** unneeded: the change cannot alter how the site looks (tests, settings, notes), so no pictures are taken. */
  status: 'none' | 'working' | 'ready' | 'failed' | 'unneeded'
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
const APP_PAGE = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/
const PAGES_PAGE = /^(?:src\/)?pages\/(.*)\.(?:tsx|jsx|ts|js|mdx)$/

/** The address a page file answers at, written as the project writes it ("/teams", "/[team]/[matchId]"); null when
 *  the file is not a page. Route groups "(site)" and slots "@modal" are not part of an address. */
export function addressOf(file: string): string | null {
  const app = APP_PAGE.exec(file)
  if (app) return `/${(app[1] ?? '').split('/').filter(s => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/')}`
  const pages = PAGES_PAGE.exec(file)
  if (pages && !/^(_|api\/)/.test(pages[1]!)) return `/${pages[1]!.replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/'
  return null
}

/** The page to photograph for a change: the first changed page with one fixed address, else the home page. */
export function routeFor(files: readonly string[]): string {
  for (const f of files) {
    const address = addressOf(f)
    if (address !== null && !address.includes('[')) return address // a page that takes a value has no one address
  }
  return '/'
}

/** The first changed page whose address takes a value ("/[team]"), when no changed page has a fixed one. */
export function valuePageFor(files: readonly string[]): string | null {
  const addresses = files.map(addressOf).filter((a): a is string => a !== null)
  if (addresses.some(a => !a.includes('['))) return null
  return addresses[0] ?? null
}

/**
 * A real address for a page that takes a value, picked from the links another page shows: the first link shaped
 * like the page's address ("/boys" for "/[team]") that is not one of the project's own fixed pages ("/admin").
 */
export function linkFor(page: string, links: readonly string[], fixedPages: readonly string[]): string | null {
  const shape = new RegExp(
    `^${page
      .split('/')
      .map(seg => (/^\[\[?\.\.\./.test(seg) ? '.+' : seg.startsWith('[') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}$`,
  )
  const fixed = new Set(fixedPages)
  for (const link of links) {
    const path = link.split(/[?#]/)[0]!.replace(/(.)\/$/, '$1')
    if (shape.test(path) && !fixed.has(path)) return path
  }
  return null
}

// Files that never change what a visitor sees: tests, notes, tooling settings and the list of installed packages.
const UNSEEN = [
  /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright|docs?|\.github|\.husky|\.vscode)\//,
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/,
  /\.(md|mdx|txt|snap|lock)$/i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|tsconfig[^/]*\.json|\.[^/]+)$/,
  /(^|\/)(vitest|jest|playwright|cypress|eslint|prettier|commitlint|lint-staged)\.config\.[cm]?[jt]s$/,
  /(^|\/)(vitest|jest)\.setup\.[cm]?[jt]sx?$/,
]
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/
/** Whether a change can alter how the site looks. Unknown (no files) counts as yes. A page counts whatever its folder is called. */
export function changesTheLook(files: readonly string[]): boolean {
  if (files.length === 0) return true
  return files.some(f => (/(^|\/)(app|pages)\//.test(f) && !TEST_FILE.test(f)) || !UNSEEN.some(re => re.test(f)))
}
const UNNEEDED: SnapshotState = { status: 'unneeded', route: null, shots: [], message: null }

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
  if (!changesTheLook(await changedFiles(runId))) return UNNEEDED
  const row = (await db.select().from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.snapshots'))).orderBy(desc(events.sequence)))[0]
  if (!row) return { status: 'none', route: null, shots: [], message: null }
  const p = JSON.parse(row.payloadJson) as { route: string | null; shots: Shot[]; message: string | null; change: string }
  if (p.change !== (await changeHash(runId))) return { status: 'none', route: null, shots: [], message: null }
  // Pictures live in R2 when it is set up (any computer can show them), otherwise on the computer that took them.
  const shots = p.shots.filter(s => storage() !== null || snapshotFile(runId, s) !== null)
  return shots.length > 0 ? { status: 'ready', route: p.route, shots, message: null } : { status: 'failed', route: p.route, shots: [], message: p.message }
}

export type Links = (url: string) => Promise<string[]>

/** The addresses on this same site that the page at `url` links to, in the order it shows them. */
export const playwrightLinks: Links = async url => {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const hrefs = await page.$$eval('a[href]', as => as.map(a => (a as HTMLAnchorElement).href))
    const origin = new URL(url).origin
    return hrefs.filter(h => h.startsWith(`${origin}/`)).map(h => h.slice(origin.length))
  } finally {
    await browser.close()
  }
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * Takes the before and after pictures of a run's change, in the background. Returns at once; snapshotState says how
 * it goes. Once at a time per run. Whatever it started (the version before, a copy of it, a browser) it stops.
 */
export async function captureBeforeAfter(runId: string, shoot: Shoot = playwrightShoot, root = SNAP_ROOT, links: Links = playwrightLinks): Promise<SnapshotState> {
  const away = await elsewhere(runId)
  if (away) throw new SnapshotError(away)
  if (working.has(runId)) return snapshotState(runId)
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run?.worktreePath || !existsSync(run.worktreePath)) throw new SnapshotError(strings.snapshots.noWorkingCopy)
  const project = await projectHere(run.projectId)
  const repo = project?.repoPath
  const from = run.deliveryBase ?? run.baseCommit
  if (!repo || !from) throw new SnapshotError(strings.snapshots.noWorkingCopy)

  const files = await changedFiles(runId)
  if (!changesTheLook(files)) return UNNEEDED
  const change = (await changeHash(runId))
  let route = routeFor(files)
  const valuePage = valuePageFor(files)
  const worktree = run.worktreePath
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
      // A project started from scratch had nothing to start before its first change: only the "after" is taken.
      const hadBefore = devCommand(beforeTree, 0) !== null
      // Both versions start at once; each is photographed as soon as it answers.
      await Promise.all([startPreview(runId), hadBefore ? startServer(beforeKey, beforeTree, repo) : null])
      working.set(runId, strings.snapshots.waiting)
      const [afterUrl, beforeUrl] = await Promise.all([untilReady(runId), hadBefore ? untilReady(beforeKey) : null])
      // The changed page takes a value in its address ("/[team]"): a real one is looked for among the home page's links.
      if (valuePage && afterUrl) {
        try {
          const fixedPages = git(worktree, ['ls-files']).split('\n').map(addressOf).filter((p): p is string => p !== null && !p.includes('['))
          route = linkFor(valuePage, await links(afterUrl), fixedPages) ?? route
        } catch {
          // The home page is photographed, as before.
        }
      }
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
      if ((hadBefore && !beforeUrl) || !afterUrl) message = strings.snapshots.didNotStart(!afterUrl ? strings.snapshots.afterVersion : strings.snapshots.beforeVersion)
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

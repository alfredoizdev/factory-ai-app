import { addressFor, changesTheLook, linkFor, pagesShowing, routeFor, snapshotFile, valuePageFor } from '@/engine/snapshots'

test('the page photographed is the one the change touched, or the home page', () => {
  expect(routeFor(['src/app/page.tsx'])).toBe('/')
  expect(routeFor(['src/app/globals.css', 'src/app/(site)/teams/page.tsx'])).toBe('/teams')
  expect(routeFor(['app/about/page.mdx'])).toBe('/about')
  expect(routeFor(['src/app/players/[id]/page.tsx'])).toBe('/')
  expect(routeFor(['pages/index.tsx'])).toBe('/')
  expect(routeFor(['src/pages/contact.tsx'])).toBe('/contact')
  expect(routeFor(['pages/api/hello.ts', 'README.md'])).toBe('/')
})

test('only the fixed picture names can be asked for', () => {
  expect(snapshotFile('r1', '../../etc/passwd')).toBeNull()
  expect(snapshotFile('r1', 'before-desktop', '/nonexistent')).toBeNull()
})

test('a change nobody can see needs no pictures', () => {
  expect(changesTheLook(['__tests__/page.test.tsx', 'package-lock.json', 'package.json', 'vitest.config.mts'])).toBe(false)
  expect(changesTheLook(['README.md', '.github/workflows/ci.yml', '.gitignore', 'tsconfig.json'])).toBe(false)
  expect(changesTheLook(['src/app/__tests__/page.test.tsx'])).toBe(false)
  expect(changesTheLook(['package.json', 'src/app/page.tsx'])).toBe(true)
  expect(changesTheLook(['src/components/Button.tsx'])).toBe(true)
  expect(changesTheLook(['src/app/docs/page.tsx'])).toBe(true)
  expect(changesTheLook(['app/about/page.mdx'])).toBe(true)
  expect(changesTheLook(['tailwind.config.ts'])).toBe(true)
  expect(changesTheLook([])).toBe(true)
})

test('a changed page that takes a value in its address gets a real one from the links of the home page', () => {
  expect(valuePageFor(['src/components/team-header.tsx', 'src/app/[team]/page.tsx'])).toBe('/[team]')
  // A changed page with a fixed address wins: no value is looked for.
  expect(valuePageFor(['src/app/[team]/page.tsx', 'src/app/about/page.tsx'])).toBeNull()
  expect(valuePageFor(['src/components/x.tsx'])).toBeNull()
  // "/admin" is one of the project's own fixed pages, not a team.
  expect(linkFor('/[team]', ['/', '/admin', '/girls/', '/boys?tab=1', '/boys/42'], ['/', '/admin'])).toBe('/girls')
  expect(linkFor('/[team]/[matchId]', ['/girls', '/boys/42#top'], ['/'])).toBe('/boys/42')
  expect(linkFor('/docs/[...slug]', ['/docs', '/docs/a/b'], [])).toBe('/docs/a/b')
  expect(linkFor('/[team]', ['/', '/admin'], ['/', '/admin'])).toBeNull()
})

test('a changed component is followed to the page that shows it, through whatever uses it on the way', () => {
  const sources = new Map([
    ['src/components/big-play-video.tsx', 'export function BigPlayVideo() {}'],
    ['src/components/match-card.tsx', 'import { BigPlayVideo } from "@/components/big-play-video";'],
    ['src/app/[team]/[matchId]/page.tsx', "import { MatchCard } from '@/components/match-card'"],
    ['src/app/[team]/page.tsx', "import { TeamHeader } from '../../components/team-header'"],
    ['src/components/team-header.tsx', "import Link from 'next/link'"],
    ['src/app/page.tsx', "import { TeamHeader } from '@/components/team-header'\nconst x = await import('./lazy')"],
    ['src/app/lazy.ts', 'export const lazy = 1'],
    ['src/lib/unused.ts', 'export const u = 1'],
  ])
  expect(pagesShowing(['src/components/big-play-video.tsx'], sources)).toEqual(['src/app/[team]/[matchId]/page.tsx'])
  expect(valuePageFor(pagesShowing(['src/components/big-play-video.tsx'], sources))).toBe('/[team]/[matchId]')
  // Used by two pages: both, and the one with a fixed address is the one photographed.
  expect(pagesShowing(['src/components/team-header.tsx'], sources).sort()).toEqual(['src/app/[team]/page.tsx', 'src/app/page.tsx'])
  expect(routeFor(pagesShowing(['src/app/lazy.ts'], sources))).toBe('/')
  expect(pagesShowing(['src/lib/unused.ts'], sources)).toEqual([])
})

test('a real address is found by following links from the home page, a few pages deep', async () => {
  const site: Record<string, string[]> = { '/': ['/', '/admin', '/girls', '/boys'], '/girls': ['/', '/girls/42?x=1', '/girls/43'], '/boys': ['/boys/7'] }
  const visited: string[] = []
  const links = async (url: string) => {
    const path = new URL(url).pathname
    visited.push(path)
    return site[path] ?? []
  }
  expect(await addressFor('/[team]/[matchId]', 'http://localhost:3000', links, ['/', '/admin'])).toBe('/girls/42')
  // The project's own fixed pages are not walked into, and it stops at the first page that has one.
  expect(visited).toEqual(['/', '/girls'])
  expect(await addressFor('/[team]', 'http://localhost:3000', links, ['/', '/admin'])).toBe('/girls')
  expect(await addressFor('/shop/[id]', 'http://localhost:3000', links, ['/', '/admin'])).toBeNull()
})

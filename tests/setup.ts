import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, vi } from 'vitest'
import { refusedRealTools, toolGuard } from './tool-guard'

// No test may run the real `gh` (it could reach GitHub) or the real `claude` (it costs money and answers differently
// each time). Every way the app starts a program goes through node:child_process, so each of its starters is wrapped:
// asking for gh or claude throws at once, and, in case the code under test swallows that error (several callers
// fall back quietly), the test is also failed afterwards with the same sentence. A test that fakes them (a fake `gh`
// or `ask` passed in, a fake `spawn`) never reaches this.
vi.mock('node:child_process', async importOriginal => toolGuard(await importOriginal<typeof import('node:child_process')>()))

afterEach(() => {
  const reached = refusedRealTools.splice(0)
  if (reached.length > 0) throw new Error(reached[0])
})

// Every test file that runs in Node gets its own in-memory Postgres (PGlite), migrated once. Screen tests (jsdom)
// never touch the database and do not load it.
if (typeof window === 'undefined') {
  beforeAll(async () => {
    // A file that mocks the client away (to prove a module never opens the database) gets no database.
    const client = await import('@/db/client').catch(() => null)
    await client?.migrateDb()
  }, 30_000)
}
afterEach(() => cleanup())

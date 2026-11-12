import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll } from 'vitest'

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

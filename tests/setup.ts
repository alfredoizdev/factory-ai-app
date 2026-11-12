import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll } from 'vitest'
import { migrateDb } from '@/db/client'

// Every test file gets its own in-memory Postgres (PGlite), migrated once.
beforeAll(() => migrateDb(), 30_000)
afterEach(() => cleanup())

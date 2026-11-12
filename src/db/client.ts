import { PGlite } from '@electric-sql/pglite'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core'
import { drizzle as drizzleLite } from 'drizzle-orm/pglite'
import { migrate as migrateLite } from 'drizzle-orm/pglite/migrator'
import { Pool } from 'pg'
import * as schema from './schema'

// The app's database is Postgres on Neon (DATABASE_URL_UNPOOLED, a direct connection: the app runs as one long-lived
// process on the person's computer). Tests use PGlite, a real Postgres in memory, so they never touch Neon.
// Both give the same Drizzle API; every call is async.

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type Tx = PgTransaction<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>
/** Anything a query can run on: the database itself, or an open transaction. */
export type DbHandle = Db | Tx

const g = globalThis as { __factoryDb?: { db: Db; migrate: () => Promise<void> } }

function connect(): { db: Db; migrate: () => Promise<void> } {
  if (process.env.VITEST) {
    const client = new PGlite()
    const db = drizzleLite(client, { schema }) as unknown as Db
    return { db, migrate: () => migrateLite(drizzleLite(client, { schema }), { migrationsFolder: './drizzle-pg' }) }
  }
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is not set. Run `neon env pull` to write it into .env.local.')
  const pool = new Pool({ connectionString: url, max: 5 })
  const db = drizzlePg(pool, { schema }) as unknown as Db
  return { db, migrate: () => migratePg(drizzlePg(pool, { schema }), { migrationsFolder: './drizzle-pg' }) }
}

// One connection per process, kept across hot reloads.
const conn = (g.__factoryDb ??= connect())
export const db: Db = conn.db

/** Applies the Postgres migrations (`npm run db:migrate`; tests call it once per file). */
export function migrateDb(): Promise<void> {
  return conn.migrate()
}

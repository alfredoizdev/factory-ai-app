import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

// FACTORY_DB_PATH overrides the location (tests use ':memory:').
const path = process.env.FACTORY_DB_PATH ?? './.factory/factory.db'
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

const sqlite = new Database(path)
sqlite.pragma('journal_mode = WAL')
// SQLite ignores foreign keys unless enabled on every connection.
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

// Applies migrations to any connection. Foreign keys are switched off around the migrator,
// outside its transaction: SQLite ignores that pragma inside a transaction, and table rebuilds
// (DROP TABLE) would otherwise fire cascades and delete child rows. Integrity is verified afterwards.
export function applyMigrations(conn: Database.Database, migrationsFolder: string): void {
  conn.pragma('foreign_keys = OFF')
  try {
    migrate(drizzle(conn), { migrationsFolder })
    const violations = conn.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) {
      throw new Error(`Migration left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`)
    }
  } finally {
    conn.pragma('foreign_keys = ON')
  }
}

export function migrateDb(): void {
  applyMigrations(sqlite, './drizzle')
}

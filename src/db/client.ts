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

export function migrateDb(): void {
  migrate(db, { migrationsFolder: './drizzle' })
}

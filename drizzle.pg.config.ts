import { defineConfig } from 'drizzle-kit'

// Postgres (Neon). The SQLite migrations in ./drizzle are kept only for the one-off copy of old data.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle-pg',
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? '' },
})

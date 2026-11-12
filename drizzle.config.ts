import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/sqlite-schema.ts',
  out: './drizzle',
  dbCredentials: { url: './.factory/factory.db' },
})

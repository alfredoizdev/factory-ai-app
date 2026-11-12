// `npm run db:migrate`: applies the Postgres migrations (drizzle-pg/) to the database in .env.local.
import { migrateDb } from '@/db/client'

const started = Date.now()
migrateDb()
  .then(() => {
    console.log(`Migrations applied in ${Date.now() - started} ms.`)
    process.exit(0)
  })
  .catch(e => {
    console.error('Migration failed:', e instanceof Error ? e.message : e)
    process.exit(1)
  })

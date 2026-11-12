// Applies the Postgres migrations (drizzle-pg/): `npm run db:local` to the local test database (also run by
// `npm run dev`), `npm run db:migrate:neon` to Neon, once a change is ready for the real data.
import { migrateDb } from '@/db/client'
import { localDb } from '@/db/where'

const started = Date.now()
migrateDb()
  .then(() => {
    console.log(`${localDb() ? 'Local test database' : 'Neon'}: migrations applied in ${Date.now() - started} ms.`)
    process.exit(0)
  })
  .catch(e => {
    console.error('Migration failed:', e instanceof Error ? e.message : e)
    process.exit(1)
  })

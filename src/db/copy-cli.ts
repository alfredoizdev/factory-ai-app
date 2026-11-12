// `npm run db:copy-from-sqlite [-- <folder with factory.db, snapshots/, attachments/>]`
// Copies the old local data into Neon and R2 and prints what it did. Exits non-zero on any conflict.
import { join, resolve } from 'node:path'
import { db } from '@/db/client'
import { copyAll } from '@/db/copy-from-sqlite'
import { registerMachine, thisMachine } from '@/engine/machine'
import { storage } from '@/engine/storage'

async function main() {
  const folder = resolve(process.argv[2] ?? '.factory')
  const store = storage()
  if (!store) console.log('R2 is not configured in .env.local: rows only, no pictures.')
  await registerMachine()
  const report = await copyAll({ sqlitePath: join(folder, 'factory.db'), db, storage: store, machine: thisMachine(), filesRoot: folder })
  console.table(report.tables)
  if (report.files.length > 0) console.table(report.files)
  console.log(report.ok ? 'Copied. Every table matches.' : 'Stopped on conflicts: those tables were not written.')
  process.exit(report.ok ? 0 : 1)
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

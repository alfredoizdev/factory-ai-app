import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { applyMigrations } from '@/db/client'

const count = (conn: Database.Database, table: string) =>
  (conn.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

test('migrating 0000 -> 0001 on a populated database keeps every row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mig-'))
  const only0000 = join(dir, 'only-0000')
  cpSync('./drizzle', only0000, { recursive: true })
  const journalPath = join(only0000, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  journal.entries = journal.entries.slice(0, 1)
  writeFileSync(journalPath, JSON.stringify(journal))

  const conn = new Database(join(dir, 'old.db'))
  conn.pragma('foreign_keys = ON')
  applyMigrations(conn, only0000)

  const t = '2026-01-01T00:00:00.000Z'
  conn.prepare(`insert into projects values ('p','p','n',?)`).run(t)
  conn.prepare(`insert into workflows values ('w','p','n','{}',?,?)`).run(t, t)
  conn.prepare(`insert into workflow_versions values ('v','p','w','{}','h',?)`).run(t)
  conn
    .prepare(`insert into runs (id,project_id,workflow_id,version_id,status,request,provider_id,created_at) values ('r','p','w','v','queued','x','fake',?)`)
    .run(t)
  conn
    .prepare(`insert into node_runs (id,project_id,run_id,block_id,state) values ('nr','p','r','build','queued')`)
    .run()
  conn.prepare(`insert into usage_records (id,project_id,node_run_id,created_at) values ('u','p','nr',?)`).run(t)

  const tables = ['projects', 'workflows', 'workflow_versions', 'runs', 'node_runs', 'usage_records']
  const before = Object.fromEntries(tables.map(n => [n, count(conn, n)]))
  expect(before).toEqual({ projects: 1, workflows: 1, workflow_versions: 1, runs: 1, node_runs: 1, usage_records: 1 })

  applyMigrations(conn, './drizzle')

  const after = Object.fromEntries(tables.map(n => [n, count(conn, n)]))
  console.log('row counts before', before, 'after', after)
  expect(after).toEqual(before)
  expect(conn.pragma('foreign_keys', { simple: true })).toBe(1)
  conn.close()
})

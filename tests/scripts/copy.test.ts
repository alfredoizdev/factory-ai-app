import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, events, projectMachines, projects, runs } from '@/db/schema'
import { copyAll } from '@/db/copy-from-sqlite'
import { memoryStorage } from '@/engine/storage'

const machine = { id: 'mac-1', name: 'Alfredo’s Mac' }

/** An old SQLite file, built with the old migrations, holding one project with a run, its events and a decision. */
function oldFile(): { path: string; files: string } {
  const dir = mkdtempSync(join(tmpdir(), 'copy-'))
  const path = join(dir, 'factory.db')
  const conn = new Database(path)
  migrate(drizzle(conn), { migrationsFolder: './drizzle' })
  const t = '2026-11-10T10:00:00.000Z'
  conn.prepare(`insert into projects (id, project_id, name, repo_path, test_command, auto_approve_low_risk, base_status, base_commit, created_at) values ('p1','p1','Comets','/Users/a/comets','pnpm test',1,'ready','abc',?)`).run(t)
  conn.prepare(`insert into workflows values ('w1','p1','Comets','{}',?,?)`).run(t, t)
  conn.prepare(`insert into workflow_versions values ('v1','p1','w1','{"blocks":[]}','h',?)`).run(t)
  conn.prepare(`insert into runs (id,project_id,workflow_id,version_id,status,request,title,title_by_person,provider_id,worktree_path,created_at) values ('r1','p1','w1','v1','completed','add a ring','Ring',1,'claude','/wt/r1',?)`).run(t)
  conn.prepare(`insert into node_runs (id,project_id,run_id,block_id,state,attempt) values ('n1','p1','r1','human','passed',1)`).run()
  for (let i = 1; i <= 3; i++) conn.prepare(`insert into events values (?, 'p1', 'r1', null, ?, 'run.started', '{"x":${i}}', ?)`).run(`e${i}`, i, t)
  conn.prepare(`insert into approvals (id,project_id,run_id,node_run_id,decision,actor,reason,diff_hash,created_at,consumed_at) values ('a1','p1','r1','n1','approved','me','ok','h',?,?)`).run(t, t)
  conn.close()
  const files = join(dir, 'files')
  mkdirSync(join(files, 'snapshots', 'r1'), { recursive: true })
  writeFileSync(join(files, 'snapshots', 'r1', 'after-desktop.png'), Buffer.from([1, 2, 3]))
  return { path, files }
}

test('every row is copied exactly, this computer keeps its folder, pictures go to R2, and a second run copies nothing', async () => {
  const { path, files } = oldFile()
  const store = memoryStorage()
  const report = await copyAll({ sqlitePath: path, db, storage: store, machine, filesRoot: files })
  expect(report.ok).toBe(true)
  expect(report.tables.find(t => t.name === 'events')).toMatchObject({ sqlite: 3, copied: 3 })
  const [p] = await db.select().from(projects).where(eq(projects.id, 'p1'))
  expect(p).toMatchObject({ name: 'Comets', testCommand: 'pnpm test', autoApproveLowRisk: true, repoPath: null })
  expect(await db.select().from(projectMachines)).toEqual([expect.objectContaining({ projectId: 'p1', machineId: 'mac-1', repoPath: '/Users/a/comets', baseStatus: 'ready', baseCommit: 'abc' })])
  expect((await db.select().from(runs).where(eq(runs.id, 'r1')))[0]).toMatchObject({ title: 'Ring', titleByPerson: true, machineId: 'mac-1', worktreePath: '/wt/r1' })
  const ev = await db.select().from(events).where(eq(events.runId, 'r1')).orderBy(asc(events.sequence))
  expect(ev.map(e => [e.id, e.sequence, e.payloadJson, e.createdAt])).toEqual([1, 2, 3].map(i => [`e${i}`, i, `{"x":${i}}`, '2026-11-10T10:00:00.000Z']))
  // Old decisions were acted on already: the relay must not tell anyone again.
  expect((await db.select().from(approvals))[0]!.deliveredAt).not.toBeNull()
  expect([...store.objects.keys()]).toEqual(['snapshots/r1/after-desktop.png'])

  const again = await copyAll({ sqlitePath: path, db, storage: store, machine, filesRoot: files })
  expect(again.ok).toBe(true)
  expect(again.tables.every(t => t.copied === 0)).toBe(true)
})

test('a row already there with different content is a conflict, and that table is not written', async () => {
  const { path, files } = oldFile()
  await copyAll({ sqlitePath: path, db, storage: null, machine, filesRoot: files })
  await db.update(runs).set({ request: 'changed since' }).where(eq(runs.id, 'r1'))
  const report = await copyAll({ sqlitePath: path, db, storage: null, machine, filesRoot: files })
  expect(report.ok).toBe(false)
  expect(report.tables.find(t => t.name === 'runs')).toMatchObject({ conflicts: 1, copied: 0 })
})

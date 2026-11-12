import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import Database from 'better-sqlite3'
import { getTableColumns, inArray, type Table } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { Db } from '@/db/client'
import * as pg from '@/db/schema'
import type { Machine } from '@/engine/machine'
import { attachmentKey, snapshotKey, type Storage } from '@/engine/storage'

// The one-off copy of the old local data (the SQLite file) into Neon and R2. Read-only on the old file. Every row keeps
// its id, timestamps, event sequence numbers and JSON text exactly; booleans become booleans. Re-runnable: a row that
// is already there identically is skipped; a row with the same id and different content is a conflict, and that
// table is not written at all. What belonged to this computer (a project's folder and base, where each run ran) is
// recorded as this computer's.

/** Parents before children, so every foreign key finds its row. */
const ORDER: readonly [string, Table][] = [
  ['projects', pg.projects],
  ['workflows', pg.workflows],
  ['workflow_versions', pg.workflowVersions],
  ['runs', pg.runs],
  ['node_runs', pg.nodeRuns],
  ['jobs', pg.jobs],
  ['events', pg.events],
  ['claims', pg.claims],
  ['evidence', pg.evidence],
  ['usage_records', pg.usageRecords],
  ['approvals', pg.approvals],
  ['attachments', pg.attachments],
  ['project_notes', pg.projectNotes],
]

export type Report = {
  tables: { name: string; sqlite: number; postgres: number; copied: number; conflicts: number }[]
  files: { folder: string; local: number; uploaded: number }[]
  ok: boolean
}

const BATCH = 200

/** A SQLite row as the Postgres table's own object: column names to keys, 0/1 to booleans for boolean columns. */
function convert(table: Table, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    if (!(col.name in raw)) continue
    const v = raw[col.name]
    out[key] = col.dataType === 'boolean' && v !== null ? Boolean(v) : v
  }
  return out
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).every(k => (a[k] ?? null) === (b[k] ?? null))

export async function copyAll(opts: { sqlitePath: string; db: Db; storage: Storage | null; machine: Machine; filesRoot: string }): Promise<Report> {
  const { db, machine } = opts
  const old = new Database(opts.sqlitePath, { readonly: true, fileMustExist: true })
  const report: Report = { tables: [], files: [], ok: true }
  const now = new Date().toISOString()
  try {
    await db.insert(pg.machines).values({ id: machine.id, name: machine.name, createdAt: now }).onConflictDoNothing()

    for (const [name, table] of ORDER) {
      const rows = (old.prepare(`select * from ${name}`).all() as Record<string, unknown>[]).map(r => convert(table, r))
      // What was this computer's moves to this computer's place; the shared row keeps no folder of one computer.
      if (name === 'runs') for (const r of rows) r.machineId = r.machineId ?? machine.id
      if (name === 'approvals') for (const r of rows) r.deliveredAt = r.deliveredAt ?? r.consumedAt ?? r.createdAt // they were all told already
      if (name === 'events') for (const r of rows) if (r.type === 'node.plan_decided') r.deliveredAt = r.deliveredAt ?? r.createdAt
      const local = name === 'projects' ? rows.map(r => ({ ...r })) : []
      if (name === 'projects') {
        for (const r of rows) Object.assign(r, { repoPath: null, baseStatus: 'none', baseCommit: null, baseLockHash: null, baseMessage: null, baseUpdatedAt: null })
      }

      const idCol = (table as unknown as { id: PgColumn }).id
      const existing = new Map<string, Record<string, unknown>>()
      for (let i = 0; i < rows.length; i += BATCH) {
        const ids = rows.slice(i, i + BATCH).map(r => r.id as string)
        for (const e of (await db.select().from(table).where(inArray(idCol, ids))) as Record<string, unknown>[]) existing.set(e.id as string, e)
      }
      const missing = rows.filter(r => !existing.has(r.id as string))
      const conflicts = rows.filter(r => existing.has(r.id as string) && !same(r, existing.get(r.id as string)!)).length
      let copied = 0
      if (conflicts === 0 && missing.length > 0) {
        await db.transaction(async tx => {
          for (let i = 0; i < missing.length; i += BATCH) await tx.insert(table).values(missing.slice(i, i + BATCH))
        })
        copied = missing.length
      }
      if (name === 'projects' && conflicts === 0) {
        for (const p of local) {
          if (!p.repoPath) continue
          await db
            .insert(pg.projectMachines)
            .values({
              projectId: p.id as string,
              machineId: machine.id,
              repoPath: p.repoPath as string,
              baseStatus: (p.baseStatus as string) ?? 'none',
              baseCommit: (p.baseCommit as string | null) ?? null,
              baseLockHash: (p.baseLockHash as string | null) ?? null,
              baseMessage: (p.baseMessage as string | null) ?? null,
              baseUpdatedAt: (p.baseUpdatedAt as string | null) ?? null,
            })
            .onConflictDoNothing()
        }
      }
      const postgres = (await db.select({ id: idCol }).from(table)).length
      report.tables.push({ name, sqlite: rows.length, postgres, copied, conflicts })
      if (conflicts > 0) report.ok = false
    }

    // Pictures and attachments into R2.
    if (opts.storage) {
      const snapRoot = join(opts.filesRoot, 'snapshots')
      let local = 0
      let uploaded = 0
      if (existsSync(snapRoot)) {
        for (const runId of readdirSync(snapRoot)) {
          const dir = join(snapRoot, runId)
          if (!statSync(dir).isDirectory()) continue
          for (const file of readdirSync(dir).filter(f => f.endsWith('.png'))) {
            local++
            await opts.storage.put(snapshotKey(runId, file.replace(/\.png$/, '')), readFileSync(join(dir, file)), 'image/png')
            uploaded++
          }
        }
      }
      report.files.push({ folder: 'snapshots', local, uploaded })
      const atts = old.prepare('select id, path, mime from attachments').all() as { id: string; path: string; mime: string }[]
      let aLocal = 0
      let aUp = 0
      for (const a of atts) {
        if (!existsSync(a.path)) continue
        aLocal++
        await opts.storage.put(attachmentKey(a.id, extname(a.path).slice(1) || 'png'), readFileSync(a.path), a.mime)
        aUp++
      }
      report.files.push({ folder: 'attachments', local: aLocal, uploaded: aUp })
    }
  } finally {
    old.close()
  }
  return report
}

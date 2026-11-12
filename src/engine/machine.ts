import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, type DbHandle } from '@/db/client'
import { machines, projectMachines, projects, runs } from '@/db/schema'
import { strings } from '@/ui/strings'

// Which computer this is. The data is shared (Neon); some things are not: a project's folder, the base prepared from
// it, and a run's working copy live on one computer. Each computer has an id of its own, kept next to the app's other
// local files, and a name a person can read ("Alfredo's MacBook").

export type Machine = { id: string; name: string }

const FILE = () => join(process.cwd(), '.factory', 'machine.json')
const g = globalThis as { __factoryMachine?: Machine; __factoryMachineSaved?: boolean }

/** This computer: from FACTORY_MACHINE_ID when set (tests), else from .factory/machine.json, made on first use. */
export function thisMachine(): Machine {
  if (process.env.FACTORY_MACHINE_ID) return { id: process.env.FACTORY_MACHINE_ID, name: process.env.FACTORY_MACHINE_NAME ?? 'this computer' }
  if (g.__factoryMachine) return g.__factoryMachine
  const file = FILE()
  let m: Machine | null = null
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Machine>
      if (typeof raw.id === 'string' && typeof raw.name === 'string') m = { id: raw.id, name: raw.name }
    } catch {
      m = null
    }
  }
  if (!m) {
    m = { id: ulid(), name: hostname().replace(/\.local$/, '') || 'this computer' }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(m, null, 2))
  }
  return (g.__factoryMachine = m)
}

/** Records this computer's name in the shared data once per process, so others can say where a working copy is. */
export async function registerMachine(): Promise<void> {
  if (g.__factoryMachineSaved) return
  const m = thisMachine()
  await db.insert(machines).values({ id: m.id, name: m.name, createdAt: new Date().toISOString() }).onConflictDoUpdate({ target: machines.id, set: { name: m.name } })
  g.__factoryMachineSaved = true
}

export async function machineName(id: string | null): Promise<string | null> {
  if (!id) return null
  return (await db.select({ name: machines.name }).from(machines).where(eq(machines.id, id)))[0]?.name ?? null
}

export type LocalProject = {
  repoPath: string | null
  baseStatus: string
  baseCommit: string | null
  baseLockHash: string | null
  baseMessage: string | null
  baseUpdatedAt: string | null
}

/**
 * A project as this computer sees it: the shared row with this computer's own folder and base. A project this
 * computer has no row for falls back to the columns from before machines existed, which only data made before then
 * (and tests) still hold; the copy into Neon moves them into this table.
 */
export async function projectHere(projectId: string, h: DbHandle = db) {
  const row = (await h.select().from(projects).where(eq(projects.id, projectId)))[0]
  if (!row) return undefined
  const local = (await h.select().from(projectMachines).where(and(eq(projectMachines.projectId, projectId), eq(projectMachines.machineId, thisMachine().id))))[0]
  if (!local) return row
  return { ...row, repoPath: local.repoPath, baseStatus: local.baseStatus, baseCommit: local.baseCommit, baseLockHash: local.baseLockHash, baseMessage: local.baseMessage, baseUpdatedAt: local.baseUpdatedAt }
}

/** Sets this computer's folder or base for a project. */
export async function setLocal(projectId: string, patch: Partial<LocalProject>, h: DbHandle = db): Promise<void> {
  const machineId = thisMachine().id
  const existing = (await h.select().from(projectMachines).where(and(eq(projectMachines.projectId, projectId), eq(projectMachines.machineId, machineId))))[0]
  if (existing) {
    await h.update(projectMachines).set(patch).where(and(eq(projectMachines.projectId, projectId), eq(projectMachines.machineId, machineId)))
    return
  }
  // First time on this computer: start from what the project had before machines existed, then apply the change.
  const legacy = (await h.select().from(projects).where(eq(projects.id, projectId)))[0]
  await h.insert(projectMachines).values({
    projectId,
    machineId,
    repoPath: legacy?.repoPath ?? null,
    baseStatus: legacy?.baseStatus ?? 'none',
    baseCommit: legacy?.baseCommit ?? null,
    baseLockHash: legacy?.baseLockHash ?? null,
    baseMessage: legacy?.baseMessage ?? null,
    baseUpdatedAt: legacy?.baseUpdatedAt ?? null,
    ...patch,
  })
}

/** Where a run executes, and whether that is here. A run with no machine recorded is treated as not here. */
export async function runPlace(runId: string): Promise<{ here: boolean; machineId: string | null; machine: string | null }> {
  const run = (await db.select({ machineId: runs.machineId }).from(runs).where(eq(runs.id, runId)))[0]
  const machineId = run?.machineId ?? null
  return { here: machineId !== null && machineId === thisMachine().id, machineId, machine: await machineName(machineId) }
}

/**
 * Null when the run's working copy is on this computer; otherwise the sentence saying where it is, for the actions
 * that need it (saving the change, trying it, sending it, the pictures, the preview).
 */
export async function elsewhere(runId: string): Promise<string | null> {
  const place = await runPlace(runId)
  return place.here ? null : strings.machine.elsewhere(place.machine)
}

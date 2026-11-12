import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { attachments, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { claimAttachments, imagePathsFor, saveAttachment } from '@/engine/attachments'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { deleteRun } from '@/engine/run-delete'
import { readSnapshot } from '@/engine/snapshots'
import { memoryStorage, setStorage, snapshotKey } from '@/engine/storage'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const now = () => new Date().toISOString()
const store = memoryStorage()
beforeEach(() => {
  store.objects.clear()
  setStorage(store)
})
afterAll(() => setStorage(null))

async function aRun(): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  return (await createRun({ workflowId, request: 'r' })).runId
}

test('a picture is read from this computer when it took it, otherwise from R2; only fixed names are read', async () => {
  const runId = await aRun()
  await store.put(snapshotKey(runId, 'after-desktop'), new Uint8Array([1, 2, 3]), 'image/png')
  expect(await readSnapshot(runId, 'after-desktop', mkdtempSync(join(tmpdir(), 'snap-')))).toEqual(new Uint8Array([1, 2, 3]))
  const get = vi.spyOn(store, 'get')
  expect(await readSnapshot(runId, '../x')).toBeNull()
  expect(await readSnapshot(runId, 'nope')).toBeNull()
  expect(get).not.toHaveBeenCalled()
})

test('an image attached here is kept in R2, and the run\'s computer fetches it when it does not have it', async () => {
  const runId = await aRun()
  const here = mkdtempSync(join(tmpdir(), 'att-'))
  const { id } = await saveAttachment('shot.png', PNG, here)
  expect(store.objects.has(`attachments/${id}.png`)).toBe(true)
  await claimAttachments([id], runId)
  // As on another computer: the original file is not there.
  rmSync(here, { recursive: true, force: true })
  const cache = mkdtempSync(join(tmpdir(), 'cache-'))
  const paths = await imagePathsFor(runId, null, cache)
  expect(paths).toEqual([join(cache, `${id}.png`)])
})

test('deleting a task deletes its pictures and attachments in R2', async () => {
  const runId = await aRun()
  await store.put(snapshotKey(runId, 'before-desktop'), new Uint8Array([1]), 'image/png')
  const { id } = await saveAttachment('shot.png', PNG, mkdtempSync(join(tmpdir(), 'att-')))
  await claimAttachments([id], runId)
  await db.update(runs).set({ status: 'completed' }).where(eq(runs.id, runId))
  await deleteRun(runId)
  expect([...store.objects.keys()]).toEqual([])
  expect(await db.select().from(attachments).where(eq(attachments.id, id))).toEqual([])
})

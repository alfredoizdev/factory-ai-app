import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { attachments, projects, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { AttachmentError, claimAttachments, imagePathsFor, MAX_IMAGE_BYTES, saveAttachment, sniffImage } from '@/engine/attachments'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { POST } from '@/app/api/attachments/route'
import { claudeArgs } from '@/providers/claude'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const dir = () => mkdtempSync(join(tmpdir(), 'factory-att-'))
// The smallest valid PNG: 1x1, transparent.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])

async function aRun(): Promise<string> {
  const projectId = ulid()
  const workflowId = ulid()
  db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: '' }).run()
  db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: '', updatedAt: '' }).run()
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  return (await createRun({ workflowId, request: 'r' })).runId
}

test('an image is recognised by its bytes, never by its name', () => {
  expect(sniffImage(PNG)).toEqual({ mime: 'image/png', ext: 'png' })
  expect(sniffImage(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' })
  expect(sniffImage(Buffer.from('#!/bin/sh\necho not an image at all'))).toBeNull()
})

test('a script renamed to .png is refused; an image is stored under a name of the app\'s choosing', () => {
  const d = dir()
  expect(() => saveAttachment('evil.png', Buffer.from('#!/bin/sh\nrm -rf / # pretending'), d)).toThrow(strings.attachments.notImage)
  const saved = saveAttachment('../../etc/passwd screenshot.png', PNG, d)
  const row = db.select().from(attachments).where(eq(attachments.id, saved.id)).get()!
  expect(row.path).toBe(join(d, `${saved.id}.png`))
  expect(readFileSync(row.path).equals(PNG)).toBe(true)
  expect(saved.name).not.toContain('/')
})

test('an image over the size limit is refused', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])
  expect(() => saveAttachment('big.png', big, dir())).toThrow(AttachmentError)
})

test('a run gets the images sent with its request; a request for changes gets only its own', async () => {
  const runId = await aRun()
  const d = dir()
  const first = saveAttachment('a.png', PNG, d)
  const later = saveAttachment('b.png', PNG, d)
  expect(claimAttachments([first.id], runId)).toBe(1)
  expect(claimAttachments([first.id], runId)).toBe(0) // already used: not claimed twice
  expect(imagePathsFor(runId)).toEqual([join(d, `${first.id}.png`)])
  claimAttachments([later.id], runId, null)
  expect(imagePathsFor(runId)).toHaveLength(2)
})

test('with images, the agent is told where they are and given read access to that folder only', () => {
  expect(claudeArgs('do it')).not.toContain('--add-dir')
  expect(claudeArgs('do it', '/app/.factory/attachments').slice(-2)).toEqual(['--add-dir', '/app/.factory/attachments'])
  expect(strings.providers.claude.imagesNote(['/x/a.png'])).toContain('/x/a.png')
})

test('only the app\'s own page can attach', async () => {
  const form = new FormData()
  form.append('file', new File([PNG], 'a.png', { type: 'image/png' }))
  const res = await POST(new Request('http://localhost:4100/api/attachments', { method: 'POST', body: form, headers: { host: 'localhost:4100' } }))
  expect(res.status).toBe(403)
})

test('from the app\'s own page an image is attached and its id comes back', async () => {
  const form = new FormData()
  form.append('file', new File([PNG], 'shot.png', { type: 'image/png' }))
  const res = await POST(
    new Request('http://localhost:4100/api/attachments', { method: 'POST', body: form, headers: { host: 'localhost:4100', 'sec-fetch-site': 'same-origin' } }),
  )
  expect(res.status).toBe(201)
  const body = (await res.json()) as { id: string; mime: string }
  expect(body.mime).toBe('image/png')
  const row = db.select().from(attachments).where(eq(attachments.id, body.id)).get()!
  expect(existsSync(row.path)).toBe(true)
})

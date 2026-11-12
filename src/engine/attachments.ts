import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { attachments } from '@/db/schema'
import { strings } from '@/ui/strings'

// Images for the agent to look at. Checked by their bytes, not their name or the browser's word for their type, kept
// in the app's own folder, and handed to the agent as paths it is given read access to.

export const ATTACHMENT_DIR = join(process.cwd(), '.factory', 'attachments')
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES = 6

export class AttachmentError extends Error {}

const SIGNATURES: readonly { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: b => b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a' },
  { mime: 'image/webp', ext: 'webp', test: b => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
]

/** What kind of image these bytes are, or null when they are not one of the kinds the agent can look at. */
export function sniffImage(bytes: Buffer): { mime: string; ext: string } | null {
  const hit = SIGNATURES.find(s => bytes.length >= 12 && s.test(bytes))
  return hit ? { mime: hit.mime, ext: hit.ext } : null
}

export async function saveAttachment(name: string, bytes: Buffer, dir: string = ATTACHMENT_DIR): Promise<{ id: string; name: string; mime: string; size: number }> {
  if (bytes.length === 0) throw new AttachmentError(strings.attachments.notImage)
  if (bytes.length > MAX_IMAGE_BYTES) throw new AttachmentError(strings.attachments.tooBig(MAX_IMAGE_BYTES / 1024 / 1024))
  const kind = sniffImage(bytes)
  if (!kind) throw new AttachmentError(strings.attachments.notImage)
  const id = ulid()
  mkdirSync(dir, { recursive: true })
  // The stored name is ours; the person's file name is kept only as a label.
  const path = join(dir, `${id}.${kind.ext}`)
  writeFileSync(path, bytes)
  const clean = name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || `image.${kind.ext}`
  await db.insert(attachments).values({ id, path, name: clean, mime: kind.mime, size: bytes.length, createdAt: new Date().toISOString() })
  return { id, name: clean, mime: kind.mime, size: bytes.length }
}

/** Gives not-yet-used attachments to a run (and, for a request for changes, to that decision). Others are ignored. */
export async function claimAttachments(ids: readonly string[], runId: string, approvalId: string | null = null): Promise<number> {
  const wanted = [...new Set(ids)].slice(0, MAX_IMAGES)
  if (wanted.length === 0) return 0
  const free = (await db.select().from(attachments).where(and(inArray(attachments.id, wanted), isNull(attachments.runId))))
  for (const a of free) await db.update(attachments).set({ runId, approvalId }).where(eq(attachments.id, a.id))
  return free.length
}

/** The image paths for a run's first round (none attached to a decision), or for one request for changes. */
export async function imagePathsFor(runId: string, approvalId: string | null = null): Promise<string[]> {
  return (await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.runId, runId), approvalId ? eq(attachments.approvalId, approvalId) : isNull(attachments.approvalId)))
    )
    .map(a => a.path)
}

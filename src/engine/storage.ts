import { localDb } from '@/db/where'
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

// Images in Cloudflare R2: the before/after pictures and the images attached to a request, so another computer sees
// and uses them too. Talked to over R2's S3 API with the keys in .env.local; the browser never sees them (the app
// streams images through its own routes). Without those keys the app keeps working with local files only.

export type Storage = {
  put(key: string, body: Uint8Array, type: string): Promise<void>
  get(key: string): Promise<{ body: Uint8Array; type: string } | null>
  /** Deletes every object under a prefix; returns how many. */
  deletePrefix(prefix: string): Promise<number>
}

const g = globalThis as { __factoryStorage?: Storage | null }

/** R2 from the environment, or null when its keys are not set or the app runs on the local test database. */
function fromEnv(): Storage | null {
  if (localDb()) return null
  const account = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  if (!account || !accessKeyId || !secretAccessKey || !bucket) return null
  const s3 = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } })
  return {
    async put(key, body, type) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: type }))
    },
    async get(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        if (!out.Body) return null
        return { body: await out.Body.transformToByteArray(), type: out.ContentType ?? 'application/octet-stream' }
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return null
        throw e
      }
    },
    async deletePrefix(prefix) {
      let deleted = 0
      let token: string | undefined
      do {
        const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        const keys = (list.Contents ?? []).map(o => o.Key).filter((k): k is string => !!k)
        if (keys.length > 0) {
          await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map(Key => ({ Key })) } }))
          deleted += keys.length
        }
        token = list.IsTruncated ? list.NextContinuationToken : undefined
      } while (token)
      return deleted
    },
  }
}

/** The storage in use: R2 when configured, a test's own when one was set, otherwise none. */
export function storage(): Storage | null {
  if (g.__factoryStorage === undefined) g.__factoryStorage = process.env.VITEST ? null : fromEnv()
  return g.__factoryStorage
}

/** Tests: use this storage (a memoryStorage()), or none. */
export function setStorage(s: Storage | null): void {
  g.__factoryStorage = s
}

/** An in-memory storage for tests. */
export function memoryStorage(): Storage & { objects: Map<string, { body: Uint8Array; type: string }> } {
  const objects = new Map<string, { body: Uint8Array; type: string }>()
  return {
    objects,
    async put(key, body, type) {
      objects.set(key, { body: new Uint8Array(body), type })
    },
    async get(key) {
      return objects.get(key) ?? null
    },
    async deletePrefix(prefix) {
      let n = 0
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) n += Number(objects.delete(k))
      return n
    },
  }
}

export const snapshotKey = (runId: string, shot: string) => `snapshots/${runId}/${shot}.png`
export const attachmentKey = (id: string, ext: string) => `attachments/${id}.${ext}`

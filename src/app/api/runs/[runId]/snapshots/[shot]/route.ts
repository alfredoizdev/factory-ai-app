import { readFileSync } from 'node:fs'
import { snapshotFile } from '@/engine/snapshots'

type Ctx = { params: Promise<{ runId: string; shot: string }> }

// One picture, by its fixed name (before-desktop, after-mobile, …): nothing else on disk can be asked for.
export async function GET(_req: Request, ctx: Ctx) {
  const { runId, shot } = await ctx.params
  if (!/^[0-9A-Z]{26}$/i.test(runId)) return new Response(null, { status: 404 })
  const file = snapshotFile(runId, shot.replace(/\.png$/, ''))
  if (!file) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(readFileSync(file)), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
}

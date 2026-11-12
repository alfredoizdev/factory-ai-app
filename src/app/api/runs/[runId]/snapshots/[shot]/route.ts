import { readSnapshot } from '@/engine/snapshots'

type Ctx = { params: Promise<{ runId: string; shot: string }> }

// One picture, by its fixed name (before-desktop, after-mobile, …): nothing else can be asked for. From this computer
// when it took it, otherwise from R2.
export async function GET(_req: Request, ctx: Ctx) {
  const { runId, shot } = await ctx.params
  if (!/^[0-9A-Z]{26}$/i.test(runId)) return new Response(null, { status: 404 })
  const bytes = await readSnapshot(runId, shot.replace(/\.png$/, ''))
  if (!bytes) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
}

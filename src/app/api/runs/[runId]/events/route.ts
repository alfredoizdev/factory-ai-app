import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs } from '@/db/schema'
import { eventsSince } from '@/engine/events'
import { strings } from '@/ui/strings'

// Server-sent events for one run. The persisted log is the source of truth: every message is read from it, in
// sequence order, starting after the client's cursor. The same read serves the replay and the live tail, so there
// is no seam between them for an event to fall through or to be sent twice.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Every second, and only while the run can still change on its own: a database that is asked constantly never sleeps,
// and on Neon's free plan that spends the month's compute hours.
export const POLL_MS = 1000
const LIVE: ReadonlySet<string> = new Set(['queued', 'running', 'waiting_approval'])
const KEEPALIVE_MS = 15_000

// ?after= wins over Last-Event-ID. An unusable cursor means "from the start": replaying too much is safe
// (the client ignores sequences it has seen), skipping is not.
function cursorFrom(req: Request): number {
  const raw = new URL(req.url).searchParams.get('after') ?? req.headers.get('last-event-id')
  if (raw === null || !/^\d+$/.test(raw)) return 0
  return Number(raw)
}

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  const run = (await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return Response.json({ error: strings.errors.runNotFound }, { status: 404 })

  let cursor = cursorFrom(req)
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let lastWrite = Date.now()
  let caughtUp = false
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        closed = true
        clearTimeout(timer)
      }
      const tick = async () => {
        if (closed) return
        try {
          for (const e of await eventsSince(runId, cursor)) {
            if (closed) return
            controller.enqueue(encoder.encode(`id: ${e.sequence}\ndata: ${JSON.stringify(e)}\n\n`))
            cursor = e.sequence
            lastWrite = Date.now()
          }
          // Once, after the replay: everything recorded so far has been sent, so the page can show the run whole.
          if (!caughtUp) {
            caughtUp = true
            controller.enqueue(encoder.encode(`event: caughtup\ndata: ${cursor}\n\n`))
          }
          // A run that has ended adds nothing on its own: the stream says so and closes instead of asking again.
          const status = (await db.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)))[0]?.s
          if (!status || !LIVE.has(status)) {
            const rest = await eventsSince(runId, cursor)
            for (const e of rest) {
              controller.enqueue(encoder.encode(`id: ${e.sequence}\ndata: ${JSON.stringify(e)}\n\n`))
              cursor = e.sequence
            }
            controller.enqueue(encoder.encode(`event: end\ndata: ${cursor}\n\n`))
            stop()
            controller.close()
            return
          }
          if (Date.now() - lastWrite >= KEEPALIVE_MS) {
            controller.enqueue(encoder.encode(': keep-alive\n\n'))
            lastWrite = Date.now()
          }
        } catch (err) {
          stop()
          controller.error(err)
          return
        }
        if (!closed) timer = setTimeout(() => void tick(), POLL_MS)
      }
      req.signal.addEventListener('abort', () => {
        stop()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
      void tick()
    },
    cancel() {
      closed = true
      clearTimeout(timer)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

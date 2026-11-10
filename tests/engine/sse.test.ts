import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { appendEvent, eventsSince, type EventRow } from '@/engine/events'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import { GET } from '@/app/api/runs/[runId]/events/route'

beforeAll(() => {
  migrateDb()
})

const now = () => new Date().toISOString()

async function startRun(): Promise<{ runId: string }> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({
    id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now(),
  })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'x' }) // appends run.created as sequence 1, then one node.queued per block
  // The tests below read a log of exactly 12 events, so the steps top up whatever createRun wrote.
  const written = (await eventsSince(runId, 0)).length
  for (let i = 0; i < 12 - written; i++) await appendEvent({ runId, type: 'node.step', payload: { blockId: 'build', text: `s${i}` } })
  return { runId }
}

type Frame = { id: string; event: EventRow }

function ctx(runId: string) {
  return { params: Promise.resolve({ runId }) }
}

// Opens the stream, reads `closeAfter` frames, then disconnects like a browser tab would.
async function readSse(
  runId: string,
  after: number,
  opts: { closeAfter: number; headers?: Record<string, string>; query?: string; onOpen?: () => Promise<void> },
): Promise<Frame[]> {
  const url = `http://x/api/runs/${runId}/events${opts.query ?? `?after=${after}`}`
  const res = await GET(new Request(url, { headers: opts.headers }), ctx(runId))
  await opts.onOpen?.()
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let buf = ''
  while (frames.length < opts.closeAfter) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
    let cut: number
    while ((cut = buf.indexOf('\n\n')) !== -1 && frames.length < opts.closeAfter) {
      const raw = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      const id = /^id: (.*)$/m.exec(raw)?.[1]
      const data = /^data: (.*)$/m.exec(raw)?.[1]
      if (id === undefined || data === undefined) continue // a comment or keep-alive
      frames.push({ id, event: JSON.parse(data) as EventRow })
    }
  }
  await reader.cancel()
  return frames
}

const seqs = (f: Frame[]) => f.map(x => x.event.sequence)

test('reconnecting from the last sequence yields no gaps and no duplicates', async () => {
  const { runId } = await startRun()
  const first = await readSse(runId, 0, { closeAfter: 3 })
  const rest = await readSse(runId, first.at(-1)!.event.sequence, { closeAfter: 5 })
  const all = seqs([...first, ...rest])
  expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
})

test('every message carries id equal to its sequence', async () => {
  const { runId } = await startRun()
  const frames = await readSse(runId, 0, { closeAfter: 4 })
  expect(frames.map(f => f.id)).toEqual(['1', '2', '3', '4'])
  expect(frames.map(f => Number(f.id))).toEqual(seqs(frames))
})

test('events that arrived while disconnected are replayed on reconnect', async () => {
  const { runId } = await startRun()
  const seen = await readSse(runId, 0, { closeAfter: 12 })
  await appendEvent({ runId, type: 'node.step', payload: { blockId: 'build', text: 'missed' } })
  const after = await readSse(runId, seen.at(-1)!.event.sequence, { closeAfter: 1 })
  expect(after[0]!.event.payload).toMatchObject({ text: 'missed' })
  expect(after[0]!.event.sequence).toBe(13)
})

test('an event appended after the stream opened is delivered once, in order', async () => {
  const { runId } = await startRun()
  // The append lands after GET returned, so it falls between "replay" and "live".
  const frames = await readSse(runId, 10, {
    closeAfter: 3,
    onOpen: async () => {
      await appendEvent({ runId, type: 'node.step', payload: { blockId: 'build', text: 'live' } })
    },
  })
  expect(seqs(frames)).toEqual([11, 12, 13])
  expect(frames[2]!.event.payload).toMatchObject({ text: 'live' })
})

test('Last-Event-ID resumes like ?after=, and ?after= wins when both are given', async () => {
  const { runId } = await startRun()
  const viaHeader = await readSse(runId, 0, { closeAfter: 2, query: '', headers: { 'Last-Event-ID': '5' } })
  expect(seqs(viaHeader)).toEqual([6, 7])
  const both = await readSse(runId, 0, { closeAfter: 1, query: '?after=8', headers: { 'Last-Event-ID': '2' } })
  expect(seqs(both)).toEqual([9])
})

test('a garbage cursor replays from the start rather than skipping events', async () => {
  const { runId } = await startRun()
  const frames = await readSse(runId, 0, { closeAfter: 1, query: '?after=banana' })
  expect(seqs(frames)).toEqual([1])
})

test('an unknown run is a 404, not an endless empty stream', async () => {
  const res = await GET(new Request('http://x/api/runs/nope/events'), ctx('nope'))
  expect(res.status).toBe(404)
})

test('the response is an event stream that is not cached', async () => {
  const { runId } = await startRun()
  const res = await GET(new Request(`http://x/api/runs/${runId}/events`), ctx(runId))
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  expect(res.headers.get('cache-control')).toContain('no-cache')
  await res.body!.cancel()
})

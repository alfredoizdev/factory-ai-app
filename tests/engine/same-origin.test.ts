import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { createRun, publishVersion } from '@/engine/run'
import { rejectCrossSite } from '@/engine/same-origin'
import { PUT as putDraft } from '@/app/api/workflows/[id]/draft/route'
import { POST as publish } from '@/app/api/workflows/[id]/publish/route'
import { POST as startRun } from '@/app/api/workflows/[id]/runs/route'
import { POST as cancel } from '@/app/api/runs/[runId]/cancel/route'

beforeAll(async () => {
  await migrateDb()
})

const now = () => new Date().toISOString()
const HOST = 'localhost:3000'
const same = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }
const evil = { host: HOST, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }

async function newWorkflow() {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  return workflowId
}
const req = (method: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`http://${HOST}/x`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('the guard', () => {
  test.each([
    ['same-origin fetch', same, false],
    ['top-level navigation or address bar', { host: HOST, 'sec-fetch-site': 'none' }, false],
    ['a client that is not a browser page (no origin headers)', { host: HOST }, false],
    ['another site', evil, true],
    ['same-site but another origin (a sibling subdomain or port)', { host: HOST, origin: 'http://localhost:4000', 'sec-fetch-site': 'same-site' }, true],
    ['a sandboxed page, origin "null"', { host: HOST, origin: 'null' }, true],
    ['a forged Origin with no fetch metadata', { host: HOST, origin: 'https://evil.example' }, true],
    // The app only answers to a loopback name. A request addressed to anything else came over the network (another
    // machine on the wifi) or through DNS rebinding (a site that points its own name at 127.0.0.1) — refused even
    // when its Origin matches its Host, because a rebound page's Origin always does.
    ['another machine on the network, no browser headers', { host: '10.0.0.118:3000' }, true],
    ['a DNS-rebound page whose Origin matches its own Host', { host: 'evil.example:3000', origin: 'http://evil.example:3000', 'sec-fetch-site': 'same-origin' }, true],
    ['127.0.0.1', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' }, false],
    ['IPv6 loopback', { host: '[::1]:3000' }, false],
    ['fetch metadata that says cross-site with a matching Origin', { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site' }, true],
  ])('%s', (_n, headers, refused) => {
    const res = rejectCrossSite(req('POST', headers))
    expect(res === null).toBe(!refused)
    if (res) expect(res.status).toBe(403)
  })
})

describe('every mutating route uses it', () => {
  test('PUT draft', async () => {
    const id = await newWorkflow()
    const params = { params: Promise.resolve({ id }) }
    const graph = { blocks: defaultGraph().blocks.map(b => ({ ...b, label: 'Hijacked' })) }
    expect((await putDraft(req('PUT', evil, graph), params)).status).toBe(403)
    const row = await db.query.workflows.findFirst({ where: eq(workflows.id, id) })
    expect(row!.draftJson).toBe(JSON.stringify(defaultGraph())) // untouched
    expect((await putDraft(req('PUT', same, graph), params)).status).toBe(200)
  })

  test('POST publish', async () => {
    const id = await newWorkflow()
    const params = { params: Promise.resolve({ id }) }
    expect((await publish(req('POST', evil), params)).status).toBe(403)
    expect((await publish(req('POST', same), params)).status).toBe(201)
  })

  test('POST runs', async () => {
    const id = await newWorkflow()
    await publishVersion(id)
    const params = { params: Promise.resolve({ id }) }
    expect((await startRun(req('POST', evil, { request: 'x' }), params)).status).toBe(403)
    expect(await db.select().from(runs).where(eq(runs.workflowId, id))).toHaveLength(0) // nothing was started
    // Same origin passes the guard and reaches the handler, which then needs Inngest to enqueue: anything but 403.
    expect((await startRun(req('POST', same, { request: 'x' }), params)).status).not.toBe(403)
  })

  test('POST cancel', async () => {
    const id = await newWorkflow()
    await publishVersion(id)
    const { runId } = await createRun({ workflowId: id, request: 'x' })
    const params = { params: Promise.resolve({ runId }) }
    expect((await cancel(req('POST', evil), params)).status).toBe(403)
    expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))!.status).toBe('queued')
    expect((await cancel(req('POST', same), params)).status).toBe(200)
    expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))!.status).toBe('cancelled')
  })
})

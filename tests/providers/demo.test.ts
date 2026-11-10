import { describe, expect, test } from 'vitest'
import type { BlockKind } from '@/domain/graph'
import { DEMO_PROVIDER_ID } from '@/engine/run'
import { createDemoProvider, demoProvider } from '@/providers/demo'
import type { AgentEvent } from '@/providers/types'
import { strings } from '@/ui/strings'

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

function ctl(): { signal: AbortSignal } {
  return { signal: new AbortController().signal }
}

const ALL_KINDS: BlockKind[] = ['input', 'plan', 'build', 'tests', 'review', 'approve', 'human', 'ship']

test('the same seed produces the same steps', async () => {
  const a = await collect(demoProvider.execute({ blockKind: 'build', request: 'x', seed: 's1' }, ctl()))
  const b = await collect(demoProvider.execute({ blockKind: 'build', request: 'x', seed: 's1' }, ctl()))
  expect(a).toEqual(b)
})

test('a request marked FAIL ends in an error event', async () => {
  const out = await collect(demoProvider.execute({ blockKind: 'build', request: 'FAIL please' }, ctl()))
  expect(out.at(-1)).toMatchObject({ type: 'error' })
})

test('aborting stops the stream', async () => {
  const c = new AbortController()
  const it = demoProvider.execute({ blockKind: 'build', request: 'x' }, { signal: c.signal })
  await it[Symbol.asyncIterator]().next()
  c.abort()
  await expect(collect(it)).resolves.toHaveLength(0)
})

test('the provider declares itself demo', () => {
  expect(demoProvider.isDemo).toBe(true)
})

test('the provider id is the shared demo constant, which is the literal demo', () => {
  expect(demoProvider.id).toBe(DEMO_PROVIDER_ID)
  expect(demoProvider.id).toBe('demo')
})

test('a successful run yields its scripted steps then done, for every block kind', async () => {
  for (const blockKind of ALL_KINDS) {
    const out = await collect(demoProvider.execute({ blockKind, request: 'x' }, ctl()))
    const steps = out.filter(e => e.type === 'step').map(e => (e as { text: string }).text)
    expect(steps).toEqual(strings.providers.demo.steps[blockKind])
    expect(out.at(-1)).toMatchObject({ type: 'done' })
    expect(out.slice(0, -1).every(e => e.type === 'step')).toBe(true)
  }
})

test('a failing run yields exactly one step then one error, and no done', async () => {
  const out = await collect(demoProvider.execute({ blockKind: 'build', request: 'please FAIL' }, ctl()))
  expect(out.map(e => e.type)).toEqual(['step', 'error'])
})

test('the done summary says the run was simulated', async () => {
  const out = await collect(demoProvider.execute({ blockKind: 'plan', request: 'x' }, ctl()))
  const done = out.at(-1)
  expect(done).toMatchObject({ type: 'done' })
  expect((done as { summary: string }).summary).toMatch(/simulated/i)
})

test('the seed changes the outcome: different seeds do not all give the same summary', async () => {
  const seeds = ['a', 'b', 'c', 'd', 'e', 'f']
  const summaries = new Set<string>()
  for (const seed of seeds) {
    const out = await collect(demoProvider.execute({ blockKind: 'ship', request: 'x', seed }, ctl()))
    summaries.add((out.at(-1) as { summary: string }).summary)
  }
  expect(summaries.size).toBeGreaterThan(1)
})

test('aborting during a pending delay ends the stream promptly', async () => {
  const slow = createDemoProvider({ stepDelayMs: 60_000 })
  const c = new AbortController()
  const it = slow.execute({ blockKind: 'build', request: 'x' }, { signal: c.signal })[Symbol.asyncIterator]()
  const pending = it.next()
  c.abort()
  await expect(pending).resolves.toMatchObject({ done: true })
})

describe('createDemoProvider', () => {
  test('keeps the demo identity whatever the delay', () => {
    const p = createDemoProvider({ stepDelayMs: 0 })
    expect(p).toMatchObject({ id: 'demo', isDemo: true })
  })
})

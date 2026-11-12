import { AsyncLocalStorage } from 'node:async_hooks'

// One at a time per run, within this app: two requests about the same run (a double click, two tabs) take turns
// instead of both passing a "not done yet" check before either has done it. Re-entrant: an action that calls another
// action on the same run (applying keeps it first) does not wait for itself.

const g = globalThis as { __factorySerial?: Map<string, Promise<unknown>> }
const tails = (g.__factorySerial ??= new Map())
const held = new AsyncLocalStorage<ReadonlySet<string>>()

export async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore()
  if (mine?.has(key)) return fn()
  const before = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>(r => (release = r))
  const tail = before.then(() => done)
  tails.set(key, tail)
  await before.catch(() => undefined)
  try {
    return await held.run(new Set([...(mine ?? []), key]), fn)
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

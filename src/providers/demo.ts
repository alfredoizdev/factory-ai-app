import type { BlockKind } from '@/domain/graph'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'
import type { AgentEvent, AgentExecutionInput, AgentProvider } from '@/providers/types'

// A fake agent for exercising the whole machine before a real one is wired in. Its output is labelled
// as simulated in the copy it yields, and the provider id drives the Demo badge in the UI.

const DEMO_STEP_DELAY_MS = 120

const FAIL_TRIGGER = 'FAIL'
const DEFAULT_SEED = 'demo'

// 32-bit FNV-1a: turns the seed string into the generator's initial state.
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// mulberry32, a small seeded generator. Each execution creates its own, so runs cannot disturb each other.
function createRandom(seed: string): () => number {
  let state = hashSeed(seed)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(items: readonly T[], roll: number): T {
  const item = items[Math.floor(roll * items.length)]
  if (item === undefined) throw new Error('Cannot pick from an empty list')
  return item
}

// Resolves after ms, or as soon as the signal aborts, whichever is first.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

export function createDemoProvider(options: { stepDelayMs?: number } = {}): AgentProvider {
  const stepDelayMs = options.stepDelayMs ?? DEMO_STEP_DELAY_MS
  const copy = strings.providers.demo

  return {
    id: DEMO_PROVIDER_ID,
    isDemo: true,
    async *execute(input: AgentExecutionInput, { signal }): AsyncGenerator<AgentEvent> {
      const roll = createRandom(input.seed ?? DEFAULT_SEED)
      const failing = input.request.includes(FAIL_TRIGGER)
      const script: readonly string[] = copy.steps[input.blockKind]
      // A failing run shows one step of progress, then fails, so the error appears after visible work.
      const visible = failing ? script.slice(0, 1) : script

      for (const text of visible) {
        await pause(stepDelayMs, signal)
        if (signal.aborted) return
        yield { type: 'step', text }
      }

      await pause(stepDelayMs, signal)
      if (signal.aborted) return
      if (failing) {
        yield { type: 'error', message: copy.failed }
      } else {
        yield { type: 'done', summary: pick(copy.summaries, roll()) }
      }
    },
  }
}

// The end-to-end test slows the Demo agent down so a block stays "running" long enough to be watched.
// Anything that is not a positive number falls back to the default.
export function stepDelayFromEnv(value: string | undefined): number | undefined {
  const n = Number(value)
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : undefined
}

export const demoProvider: AgentProvider = createDemoProvider({
  stepDelayMs: stepDelayFromEnv(process.env.FACTORY_DEMO_STEP_DELAY_MS),
})

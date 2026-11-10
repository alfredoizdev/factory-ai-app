import type { BlockKind } from '@/domain/graph'

// The contract every agent provider implements. Nothing here may depend on a specific provider, the
// database or the event log: a provider yields activity and the executor decides what to record.
// A stream ends with exactly one terminal event (done or error), unless the signal aborts first.

export type AgentEvent =
  | { type: 'step'; text: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string }

export type AgentExecutionInput = { blockKind: BlockKind; request: string; seed?: string }

export type ExecutionControls = { signal: AbortSignal }

export interface AgentProvider {
  id: string
  isDemo: boolean
  execute(input: AgentExecutionInput, controls: ExecutionControls): AsyncIterable<AgentEvent>
  cancel?(providerRunId: string): Promise<void>
}

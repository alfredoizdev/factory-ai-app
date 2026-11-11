import type { BlockKind } from '@/domain/graph'
import type { TestRun } from '@/engine/test-runner'

// The contract every agent provider implements. Nothing here may depend on a specific provider, the
// database or the event log: a provider yields activity and the executor decides what to record.
// A stream ends with exactly one terminal event (done or error), unless the signal aborts first.

export type AgentEvent =
  | { type: 'step'; text: string }
  // `source` says who wrote the summary: 'system' only when the app composed it from facts; anything else is a claim.
  // `usage` carries only what the provider itself reported; a figure it did not report is null, never 0.
  | { type: 'done'; summary: string; source?: 'provider' | 'system'; usage?: { tokens: number | null } }
  // Same rule for a failure: 'system' marks a sentence the app composed from facts. `cause` names a failure the
  // executor must not retry (re-running failing tests twice proves nothing new).
  | { type: 'error'; message: string; source?: 'provider' | 'system'; cause?: 'tests_failed' }
  // A fact a non-model process produced (the test runner). Stored as evidence, never as a claim.
  | { type: 'evidence'; kind: 'test_run'; data: TestRun }

export type AgentExecutionInput = {
  blockKind: BlockKind
  request: string
  seed?: string
  /** The run's own worktree. Absent for providers that touch no repository. */
  workdir?: string
  /** The project's configured test command; null when none is set. */
  testCommand?: string | null
  /** The commit the worktree started from, so a block can tell what this run changed. */
  baseCommit?: string
  /** Set on a later round: what the person asked to change after looking at the previous one. */
  revisionNote?: string
}

/** How a provider takes part in a block: it runs it, or the block is skipped with a reason the canvas shows. */
export type BlockRoute = { mode: 'execute' } | { mode: 'skip'; reason: string }

export type ExecutionControls = { signal: AbortSignal }

export interface AgentProvider {
  id: string
  isDemo: boolean
  /** True when the provider works on files: the executor makes the run's worktree before any block runs. */
  needsWorkspace?: boolean
  /** Absent: the provider executes every block it is given. */
  route?(kind: BlockKind, context: { testCommand?: string | null }): BlockRoute
  execute(input: AgentExecutionInput, controls: ExecutionControls): AsyncIterable<AgentEvent>
  cancel?(providerRunId: string): Promise<void>
}

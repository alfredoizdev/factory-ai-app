import type { BlockKind } from '@/domain/graph'
import type { Job } from '@/engine/plan'
import type { Repro } from '@/engine/repro'
import type { FindingType, Focus, Review } from '@/engine/review'
import type { TestRun } from '@/engine/test-runner'
import type { Standing } from '@/engine/register'

// The contract every agent provider implements. Nothing here may depend on a specific provider, the
// database or the event log: a provider yields activity and the executor decides what to record.
// A stream ends with exactly one terminal event (done or error), unless the signal aborts first.

export type AgentEvent =
  | { type: 'step'; text: string }
  // `source` says who wrote the summary: 'system' only when the app composed it from facts; anything else is a claim.
  // `usage` carries only what the provider itself reported; a figure it did not report is null, never 0.
  // `fullText`: the provider's whole final answer, for a block that reads structure from it. `review`: a reviewer's
  // verdict and findings, read from that answer — still the model's claim, never a measurement.
  // `plan`: a planner's jobs, read from its answer — its proposal, which the person checks before anything is built.
  // `repro`: a verifier's reproduction (null: it did not reproduce the problem); `refuted`: it showed the cited code
  // does not do what the finding says. Both are the model's claims until the app runs the repro itself.
  | { type: 'done'; summary: string; source?: 'provider' | 'system'; usage?: { tokens: number | null }; fullText?: string; review?: Review; plan?: Job[]; repro?: Repro | null; refuted?: { why: string } }
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
  /** Who asked for that round's changes: the person, or a reviewer. */
  revisionFrom?: 'person' | 'reviewer'
  /** Set on a follow-up run: the approved request whose change is already in the folder. */
  previousRequest?: string
  /** Absolute paths of images the person attached for this round, for the agent to look at. */
  images?: string[]
  /** The model chosen on the block, when one was. Absent: the agent's own default. */
  model?: string
  /** The plan the person checked: the builder's work list. Absent: no plan (the builder works from the request). */
  jobs?: Job[]
  /** The project's rules from earlier tasks, to follow unless this request says otherwise. */
  notes?: string[]
  /** Everything the project's register stands on for this task: rules, decisions and core areas, numbered. */
  standing?: Standing[]
  /** A review block: the one thing this reviewer looks for. Absent: a general review. */
  focus?: Focus
  /** A review block: what the builder said it did. */
  builderSummary?: string
  /** Set for a verifier (confirms one finding in a throwaway copy, `workdir`) or, later, a fixer. Absent: the block's own agent. */
  role?: 'verifier' | 'fixer'
  /** The finding a verifier or fixer works on. */
  finding?: { type: FindingType; file?: string; line?: number; problem: string }
  /** The reproduction a fixer must make pass. */
  repro?: Repro
  /** A review block after fixes were made: the paths that changed since the first review (at most 200, `more` counts the rest) and that change as a unified diff. */
  reviewSince?: { paths: string[]; diff: string; more?: number }
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

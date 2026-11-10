import { strings } from '@/ui/strings'
import type { BlockKind } from '@/domain/graph'
import type { NodeState } from '@/domain/states'

export type SummaryInput = {
  kind: BlockKind
  state: NodeState
  counts?: { passed: number; failed: number; total: number }
  jobCount?: number
  skippedReason?: string
  // The reviewer's own structured explanation. Returned verbatim, never generated here.
  claim?: string
  // Who wrote `claim`. Only the exact value 'system' marks it as written by the app itself; absent, 'provider' and
  // anything unrecognised all mean a model may have written it, so it is treated as a claim.
  claimSource?: string
}

type StateCopy = Partial<Record<NodeState, string>>

const KIND_COPY: Partial<Record<BlockKind, StateCopy>> = {
  input: strings.summary.input,
  plan: strings.summary.plan,
  build: strings.summary.build,
  review: strings.summary.review,
  approve: strings.summary.approve,
  human: strings.summary.human,
  ship: strings.summary.ship,
}

// A reviewer sentence can only describe work that has happened.
const CLAIM_STATES: ReadonlySet<NodeState> = new Set<NodeState>(['passed', 'failed', 'waiting_approval'])

// Precedence, highest first:
//   1. evidence: a sentence built from real counts or job numbers
//   2. claim: the sentence in `claim`, only in CLAIM_STATES. A system-authored one is returned verbatim but is not
//      a claim (claimUsed is false); every other source is a claim
//   3. skipped reason, for skipped blocks
//   4. template: per-kind, then generic, which is total over NodeState
// claimUsed and summarize both read this chain, so they cannot disagree.
export function summarize(input: SummaryInput): string {
  const evidence = evidenceSentence(input)
  if (evidence !== undefined) return evidence

  const claim = usableClaim(input) ?? systemSentence(input)
  if (claim !== undefined) return claim

  if (input.state === 'skipped' && hasText(input.skippedReason)) return input.skippedReason

  return templateSentence(input)
}

// True exactly when summarize returns input.claim. The UI uses this to mark a
// model-authored sentence as a claim.
export function claimUsed(input: SummaryInput): boolean {
  return usableClaim(input) !== undefined
}

function usableClaim(input: SummaryInput): string | undefined {
  if (input.claimSource === 'system') return undefined
  return carriedSentence(input)
}

function systemSentence(input: SummaryInput): string | undefined {
  return input.claimSource === 'system' ? carriedSentence(input) : undefined
}

function carriedSentence(input: SummaryInput): string | undefined {
  if (evidenceSentence(input) !== undefined) return undefined
  if (!CLAIM_STATES.has(input.state)) return undefined
  return hasText(input.claim) ? input.claim : undefined
}

function hasText(text: string | undefined): text is string {
  return text !== undefined && text.trim() !== ''
}

function evidenceSentence({ kind, state, counts, jobCount }: SummaryInput): string | undefined {
  if (kind === 'tests' && counts !== undefined) {
    if (state === 'running') return strings.summary.testsRunning(counts.total)
    if (state === 'passed') return strings.summary.testsPassed(counts.passed, counts.total)
    if (state === 'failed') return strings.summary.testsFailed(counts.passed, counts.failed, counts.total)
  }

  if (kind === 'build' && state === 'passed' && jobCount !== undefined) {
    return strings.summary.jobsFinished(jobCount)
  }

  return undefined
}

function templateSentence({ kind, state }: SummaryInput): string {
  if (kind === 'tests') {
    const tests = strings.summary.tests
    if (state === 'queued') return tests.queued
    if (state === 'running') return tests.running
    if (state === 'passed') return strings.summary.passedWithoutCounts
    if (state === 'failed') return strings.summary.failedWithoutCounts
  }

  return KIND_COPY[kind]?.[state] ?? strings.summary.generic[state]
}

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

// Every block kind and node state yields a sentence: the generic table is
// total, so a kind-specific gap always falls back to it.
export function summarize(input: SummaryInput): string {
  if (input.claim !== undefined && input.claim.trim() !== '') return input.claim

  const special = countSentence(input)
  if (special !== undefined) return special

  if (input.state === 'skipped' && input.skippedReason !== undefined && input.skippedReason.trim() !== '') {
    return input.skippedReason
  }

  return KIND_COPY[input.kind]?.[input.state] ?? strings.summary.generic[input.state]
}

function countSentence({ kind, state, counts, jobCount }: SummaryInput): string | undefined {
  if (kind === 'tests') {
    const tests = strings.summary.tests
    if (state === 'queued') return tests.queued
    if (state === 'running') {
      return counts === undefined ? tests.running : strings.summary.testsRunning(counts.total)
    }
    if (state === 'passed') {
      if (counts === undefined) return strings.summary.passedWithoutCounts
      return strings.summary.testsPassed(counts.passed, counts.total)
    }
    if (state === 'failed') {
      if (counts === undefined) return strings.summary.failedWithoutCounts
      return strings.summary.testsFailed(counts.passed, counts.failed, counts.total)
    }
    return undefined
  }

  if (kind === 'build' && state === 'passed' && jobCount !== undefined) {
    return strings.summary.jobsFinished(jobCount)
  }

  return undefined
}

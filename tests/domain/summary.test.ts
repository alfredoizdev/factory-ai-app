import { expect, test } from 'vitest'
import { STAGE_ORDER, type BlockKind } from '@/domain/graph'
import { claimUsed, summarize, type SummaryInput } from '@/domain/summary'
import type { NodeState } from '@/domain/states'

const ALL_STATES: readonly NodeState[] = [
  'queued',
  'running',
  'waiting_approval',
  'passed',
  'failed',
  'cancelled',
  'skipped',
  'blocked',
]

test('a skipped block says why', () => {
  expect(summarize({ kind: 'build', state: 'skipped', skippedReason: 'Not needed for this change' })).toBe(
    'Not needed for this change',
  )
})

test('tests report real counts, never a bare pass', () => {
  expect(summarize({ kind: 'tests', state: 'failed', counts: { passed: 4, failed: 1, total: 5 } })).toBe(
    '4 of 5 passed. 1 failed.',
  )
})

test('tests that pass with counts report them', () => {
  expect(summarize({ kind: 'tests', state: 'passed', counts: { passed: 5, failed: 0, total: 5 } })).toBe(
    '5 of 5 passed.',
  )
})

test('tests without counts never claim a bare pass or fail', () => {
  expect(summarize({ kind: 'tests', state: 'passed' })).toBe('Passed, but no test counts were recorded.')
  expect(summarize({ kind: 'tests', state: 'failed' })).toBe('Failed. No test counts were recorded.')
})

test('the human gate states that nothing proceeds', () => {
  expect(summarize({ kind: 'human', state: 'waiting_approval' })).toBe('Stopped. Nothing ships without your yes.')
})

test('a blocked block says it needs a decision, not that it is idle', () => {
  expect(summarize({ kind: 'build', state: 'blocked' })).toBe(
    'Blocked. Needs a decision or a fix before it can run.',
  )
})

test('a cancelled block says nothing after it ran', () => {
  expect(summarize({ kind: 'ship', state: 'cancelled' })).toBe('Not shipped.')
  expect(summarize({ kind: 'plan', state: 'cancelled' })).toBe('Cancelled. Nothing after this ran.')
})

test('a reviewer claim is returned verbatim', () => {
  expect(
    summarize({
      kind: 'review',
      state: 'passed',
      claim: 'The change only touches the summary module.',
    }),
  ).toBe('The change only touches the summary module.')
})

test('a blank claim falls back to the templated sentence', () => {
  expect(summarize({ kind: 'review', state: 'passed', claim: '   ' })).toBe('Review passed.')
})

test('build reports how many agent jobs finished', () => {
  expect(summarize({ kind: 'build', state: 'passed', jobCount: 3 })).toBe('3 agent jobs finished.')
  expect(summarize({ kind: 'build', state: 'passed', jobCount: 1 })).toBe('1 agent job finished.')
})

test('a collapsed card is never empty', () => {
  for (const kind of STAGE_ORDER)
    for (const state of ['queued', 'running', 'passed', 'failed'] as const)
      expect(summarize({ kind, state }).length).toBeGreaterThan(0)
})

test('every block kind and node state produces a sentence', () => {
  for (const kind of STAGE_ORDER)
    for (const state of ALL_STATES) {
      const sentence: string = summarize({ kind, state })
      expect(sentence.trim().length, `${kind} / ${state}`).toBeGreaterThan(0)
    }
})

test('every sentence is plain text with no placeholders left in it', () => {
  for (const kind of STAGE_ORDER as readonly BlockKind[])
    for (const state of ALL_STATES) {
      const sentence = summarize({
        kind,
        state,
        counts: { passed: 2, failed: 1, total: 3 },
        jobCount: 2,
        skippedReason: 'Not needed for this change',
      })
      expect(sentence).not.toMatch(/\$\{|undefined|NaN/)
    }
})

const CLAIM = 'The reviewer found the change safe.'

test('a claim never outranks a queued, blocked, cancelled or skipped state', () => {
  expect(summarize({ kind: 'review', state: 'queued', claim: CLAIM })).toBe('Waits for the tests.')
  expect(summarize({ kind: 'review', state: 'blocked', claim: CLAIM })).toBe(
    'Blocked. Needs a decision or a fix before it can run.',
  )
  expect(summarize({ kind: 'review', state: 'cancelled', claim: CLAIM })).toBe('Cancelled. Nothing after this ran.')
  expect(summarize({ kind: 'review', state: 'skipped', claim: CLAIM })).toBe('Skipped for this change.')
})

test('a failed tests block keeps its counts over a claim', () => {
  expect(
    summarize({ kind: 'tests', state: 'failed', counts: { passed: 4, failed: 1, total: 5 }, claim: CLAIM }),
  ).toBe('4 of 5 passed. 1 failed.')
})

test('a passed block with a claim and no counts returns the claim', () => {
  expect(summarize({ kind: 'review', state: 'passed', claim: CLAIM })).toBe(CLAIM)
})

test('a waiting approval block with a claim returns the claim', () => {
  expect(summarize({ kind: 'approve', state: 'waiting_approval', claim: CLAIM })).toBe(CLAIM)
})

test('a skipped reason outranks a claim', () => {
  expect(
    summarize({ kind: 'review', state: 'skipped', skippedReason: 'Not needed for this change', claim: CLAIM }),
  ).toBe('Not needed for this change')
})

test('claimUsed agrees with what summarize returns', () => {
  const states: readonly NodeState[] = [
    'queued',
    'running',
    'waiting_approval',
    'passed',
    'failed',
    'cancelled',
    'skipped',
    'blocked',
  ]
  const counts = { passed: 4, failed: 1, total: 5 }
  const claims: readonly (string | undefined)[] = [undefined, '   ', CLAIM]
  const kinds: readonly BlockKind[] = ['tests', 'review', 'build', 'approve']
  let checked = 0
  for (const kind of kinds)
    for (const state of states)
      for (const claim of claims)
        for (const withCounts of [false, true]) {
          const input: SummaryInput = {
            kind,
            state,
            ...(claim === undefined ? {} : { claim }),
            ...(withCounts ? { counts } : {}),
          }
          expect(claimUsed(input), JSON.stringify(input)).toBe(summarize(input) === input.claim)
          checked++
        }
  expect(checked).toBe(kinds.length * states.length * claims.length * 2)
})

test('claimUsed is false for a queued input carrying a claim', () => {
  expect(claimUsed({ kind: 'review', state: 'queued', claim: CLAIM })).toBe(false)
})

test('claimUsed is false when counts win over a claim', () => {
  expect(
    claimUsed({ kind: 'tests', state: 'failed', counts: { passed: 4, failed: 1, total: 5 }, claim: CLAIM }),
  ).toBe(false)
})

test('claimUsed is true only when the claim is returned', () => {
  expect(claimUsed({ kind: 'review', state: 'passed', claim: CLAIM })).toBe(true)
  expect(claimUsed({ kind: 'review', state: 'passed', claim: '  ' })).toBe(false)
})

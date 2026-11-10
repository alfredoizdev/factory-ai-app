import { expect, test } from 'vitest'
import {
  canTransition,
  isTerminal,
  rollUpRunStatus,
  type NodeState,
} from '@/domain/states'

const ALL_NODE_STATES: NodeState[] = [
  'queued',
  'running',
  'waiting_approval',
  'passed',
  'failed',
  'cancelled',
  'skipped',
  'blocked',
]

test('a terminal state cannot move again', () => {
  expect(canTransition('passed', 'running')).toBe(false)
  expect(canTransition('cancelled', 'queued')).toBe(false)
})
test('a failed node makes the run failed even when others passed', () => {
  expect(rollUpRunStatus(['passed','passed','failed'])).toBe('failed')
})
test('a run waiting on a human is not completed', () => {
  expect(rollUpRunStatus(['passed','waiting_approval'])).toBe('waiting_approval')
})
test('skipped nodes do not block completion', () => {
  expect(rollUpRunStatus(['passed','skipped'])).toBe('completed')
})
test('a run with no nodes is not reported as completed', () => {
  expect(rollUpRunStatus([])).toBe('queued')
})
test('a run containing a blocked node needs a human, not idle', () => {
  expect(rollUpRunStatus(['passed','blocked'])).toBe('waiting_approval')
})
test('terminal states are exactly those with no outgoing transition', () => {
  expect(isTerminal('passed')).toBe(true)
  expect(isTerminal('failed')).toBe(true)
  expect(isTerminal('cancelled')).toBe(true)
  expect(isTerminal('skipped')).toBe(true)
  expect(isTerminal('blocked')).toBe(false)
  expect(isTerminal('queued')).toBe(false)
  expect(isTerminal('running')).toBe(false)
  expect(isTerminal('waiting_approval')).toBe(false)
})
test('a queued node can start running and a running node can await approval', () => {
  expect(canTransition('queued', 'running')).toBe(true)
  expect(canTransition('running', 'waiting_approval')).toBe(true)
  expect(canTransition('waiting_approval', 'running')).toBe(true)
})
test('a blocked node can re-queue once its blocker clears, but cannot jump to running', () => {
  expect(canTransition('blocked', 'queued')).toBe(true)
  expect(canTransition('blocked', 'skipped')).toBe(true)
  expect(canTransition('blocked', 'cancelled')).toBe(true)
  expect(canTransition('blocked', 'running')).toBe(false)
})

// Each row: a node state that must win over another, and the run status it produces.
const PRECEDENCE: ReadonlyArray<readonly [NodeState, NodeState, string]> = [
  ['failed', 'cancelled', 'failed'],
  ['cancelled', 'waiting_approval', 'cancelled'],
  ['waiting_approval', 'running', 'waiting_approval'],
  ['running', 'queued', 'running'],
  ['cancelled', 'passed', 'cancelled'],
  ['blocked', 'running', 'waiting_approval'],
  ['queued', 'passed', 'queued'],
]
test.each(PRECEDENCE)('%s outranks %s in the roll-up (-> %s)', (winner, loser, expected) => {
  expect(rollUpRunStatus([loser, winner])).toBe(expected)
  expect(rollUpRunStatus([winner, loser])).toBe(expected)
})

test('every NodeState has a roll-up entry that yields a run status', () => {
  for (const state of ALL_NODE_STATES) {
    expect(rollUpRunStatus([state])).toEqual(expect.any(String))
  }
  expect(rollUpRunStatus(['passed'])).toBe('completed')
  expect(rollUpRunStatus(['skipped'])).toBe('completed')
})

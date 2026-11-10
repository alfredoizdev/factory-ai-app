import { expect, test } from 'vitest'
import { canTransition, isTerminal, rollUpRunStatus } from '@/domain/states'

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
test('a blocked node keeps the run from completing', () => {
  expect(rollUpRunStatus(['passed','blocked'])).toBe('queued')
})
test('terminal states are exactly those with no outgoing transition', () => {
  expect(isTerminal('passed')).toBe(true)
  expect(isTerminal('failed')).toBe(true)
  expect(isTerminal('cancelled')).toBe(true)
  expect(isTerminal('skipped')).toBe(true)
  expect(isTerminal('blocked')).toBe(true)
  expect(isTerminal('queued')).toBe(false)
  expect(isTerminal('running')).toBe(false)
  expect(isTerminal('waiting_approval')).toBe(false)
})
test('a queued node can start running and a running node can await approval', () => {
  expect(canTransition('queued', 'running')).toBe(true)
  expect(canTransition('running', 'waiting_approval')).toBe(true)
  expect(canTransition('waiting_approval', 'running')).toBe(true)
})

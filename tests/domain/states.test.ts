import {
  NODE_RUN_STATUS,
  canTransition,
  isTerminal,
  rollUpRunStatus,
  type NodeState,
  type RunStatus,
} from '@/domain/states'

// Pins what each node state means for a run. Typed as Record<NodeState, ...>,
// so adding a NodeState without a row here fails to compile.
const EXPECTED_RUN_STATUS: Record<NodeState, RunStatus> = {
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'waiting_approval',
  waiting_approval: 'waiting_approval',
  running: 'running',
  queued: 'queued',
  passed: 'completed',
  skipped: 'completed',
}

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

test('each node state maps to the run status it means', () => {
  for (const state of Object.keys(EXPECTED_RUN_STATUS) as NodeState[]) {
    expect(NODE_RUN_STATUS[state], state).toBe(EXPECTED_RUN_STATUS[state])
  }
})

test('the mapping has exactly the states the table names, no more and no fewer', () => {
  expect(Object.keys(NODE_RUN_STATUS).sort()).toEqual(
    Object.keys(EXPECTED_RUN_STATUS).sort(),
  )
})

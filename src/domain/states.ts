export type NodeState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'blocked'

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

// States with an empty list are terminal: nothing may move them again.
const TRANSITIONS: Record<NodeState, readonly NodeState[]> = {
  queued: ['running', 'skipped', 'blocked', 'cancelled'],
  running: ['waiting_approval', 'passed', 'failed', 'cancelled'],
  waiting_approval: ['running', 'passed', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
  skipped: [],
  blocked: [],
}

// Highest precedence first. A blocked node is not finished, so it counts as queued.
const ROLL_UP_PRECEDENCE: ReadonlyArray<readonly [NodeState, RunStatus]> = [
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['waiting_approval', 'waiting_approval'],
  ['running', 'running'],
  ['queued', 'queued'],
  ['blocked', 'queued'],
]

export function canTransition(from: NodeState, to: NodeState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isTerminal(state: NodeState): boolean {
  return TRANSITIONS[state].length === 0
}

export function rollUpRunStatus(nodeStates: NodeState[]): RunStatus {
  // Nothing has run, so there is no evidence of success.
  if (nodeStates.length === 0) return 'queued'

  for (const [nodeState, runStatus] of ROLL_UP_PRECEDENCE) {
    if (nodeStates.includes(nodeState)) return runStatus
  }

  // Only passed and skipped remain.
  return 'completed'
}

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
  blocked: ['queued', 'skipped', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
  skipped: [],
}

// Total mapping: adding a NodeState without an entry here fails to compile.
// A blocked node needs a human decision or fix, so it rolls up as waiting on
// one, never as idle.
export const NODE_RUN_STATUS: Record<NodeState, RunStatus> = {
  queued: 'queued',
  running: 'running',
  waiting_approval: 'waiting_approval',
  blocked: 'waiting_approval',
  passed: 'completed',
  skipped: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

// Lower rank wins the roll-up: failed > cancelled > waiting_approval > running > queued > completed.
const RUN_STATUS_RANK: Record<RunStatus, number> = {
  failed: 0,
  cancelled: 1,
  waiting_approval: 2,
  running: 3,
  queued: 4,
  completed: 5,
}

export function canTransition(from: NodeState, to: NodeState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isTerminal(state: NodeState): boolean {
  return TRANSITIONS[state].length === 0
}

export function rollUpRunStatus(nodeStates: NodeState[]): RunStatus {
  // Nothing has run, so there is no evidence of success.
  if (nodeStates.length === 0) return 'queued'

  let result: RunStatus = 'completed'
  for (const state of nodeStates) {
    const status = NODE_RUN_STATUS[state]
    if (RUN_STATUS_RANK[status] < RUN_STATUS_RANK[result]) result = status
  }
  return result
}

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { BlockCard, visualStateOf } from '@/ui/canvas/BlockCard'
import type { Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'

const buildBlock: Block = {
  id: 'build',
  kind: 'build',
  label: 'Build',
  enabled: true,
  config: {},
  position: { x: 0, y: 0 },
}

test('a collapsed card shows name and a result line, never a bare status', () => {
  render(<BlockCard block={buildBlock} view={{ state: 'skipped', summary: 'Not needed for this change' }} />)
  expect(screen.getByText('Build')).toBeInTheDocument()
  expect(screen.getByText('Not needed for this change')).toBeInTheDocument()
})

// Review Focus 5
test('unknown cost renders as not reported, never zero', () => {
  render(
    <BlockCard
      expanded
      block={buildBlock}
      view={{ state: 'passed', summary: 'Done', usage: { tokens: null, costCents: null } }}
    />,
  )
  expect(screen.getAllByText(/not reported/i)).toHaveLength(2)
  expect(screen.queryByText('$0.00')).toBeNull()
  expect(screen.queryByText('0')).toBeNull()
})

test('reported cost and tokens render as numbers', () => {
  render(
    <BlockCard
      expanded
      block={buildBlock}
      view={{ state: 'passed', summary: 'Done', usage: { tokens: 1200, costCents: 345 } }}
    />,
  )
  expect(screen.getByText('$3.45')).toBeInTheDocument()
  expect(screen.getByText('1,200')).toBeInTheDocument()
  expect(screen.queryByText(/not reported/i)).toBeNull()
})

test('a card with no usage data at all shows no cost line', () => {
  render(<BlockCard expanded block={buildBlock} view={{ state: 'passed', summary: 'Done' }} />)
  expect(screen.queryByText(/cost/i)).toBeNull()
})

test('state is conveyed by text as well as colour', () => {
  render(<BlockCard block={buildBlock} view={{ state: 'failed', summary: 'Stopped' }} />)
  expect(screen.getByLabelText(/failed/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/failed/i)).toHaveTextContent(/failed/i)
})

test('a model claim is visibly marked, a verified line is not', () => {
  const { rerender } = render(
    <BlockCard block={buildBlock} view={{ state: 'passed', summary: 'Looks right', summaryIsClaim: true }} />,
  )
  expect(screen.getByText(/AI says/i)).toBeInTheDocument()
  rerender(<BlockCard block={buildBlock} view={{ state: 'passed', summary: 'Done.', summaryIsClaim: false }} />)
  expect(screen.queryByText(/AI says/i)).toBeNull()
})

test('expanded card lists steps; collapsed does not', () => {
  const view = { state: 'running' as const, summary: 'Working', steps: ['Wrote file A'] }
  const { rerender } = render(<BlockCard block={buildBlock} view={view} />)
  expect(screen.queryByText('Wrote file A')).toBeNull()
  rerender(<BlockCard expanded block={buildBlock} view={view} />)
  expect(screen.getByText('Wrote file A')).toBeInTheDocument()
})

test('visualStateOf maps every node state', () => {
  const expected: Record<NodeState, string> = {
    queued: 'skipped',
    running: 'running',
    waiting_approval: 'waiting',
    passed: 'passed',
    failed: 'failed',
    cancelled: 'skipped',
    skipped: 'skipped',
    blocked: 'failed',
  }
  for (const [state, visual] of Object.entries(expected)) {
    expect(visualStateOf(state as NodeState)).toBe(visual)
  }
})

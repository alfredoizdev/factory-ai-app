// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { BlockCard, CARD_WIDTH, visualStateOf } from '@/ui/canvas/BlockCard'
import { strings } from '@/ui/strings'
import { LANE_SPACING } from '@/domain/graph'
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
  render(<BlockCard block={buildBlock} view={{ state: 'skipped', summary: 'Not needed for this change', summaryIsClaim: false }} />)
  expect(screen.getByText('Build')).toBeInTheDocument()
  expect(screen.getByText('Not needed for this change')).toBeInTheDocument()
})

// Review Focus 5
test('unknown cost renders as not reported, never zero', () => {
  render(
    <BlockCard
      expanded
      block={buildBlock}
      view={{ state: 'passed', summary: 'Done', summaryIsClaim: false, usage: { tokens: null, costCents: null } }}
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
      view={{ state: 'passed', summary: 'Done', summaryIsClaim: false, usage: { tokens: 1200, costCents: 345 } }}
    />,
  )
  expect(screen.getByText('$3.45')).toBeInTheDocument()
  expect(screen.getByText('1,200')).toBeInTheDocument()
  expect(screen.queryByText(/not reported/i)).toBeNull()
})

test('a card with no usage data at all shows no cost line', () => {
  render(<BlockCard expanded block={buildBlock} view={{ state: 'passed', summary: 'Done', summaryIsClaim: false }} />)
  expect(screen.queryByText(/cost/i)).toBeNull()
})

test('state is conveyed by text as well as colour', () => {
  render(<BlockCard block={buildBlock} view={{ state: 'failed', summary: 'Stopped', summaryIsClaim: false }} />)
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

// A card is tall enough to carry one live line, so a collapsed card says what the block is doing now.
// The history behind that line is still only on the expanded card.
test('a collapsed card shows the latest step only; the list behind it needs expanding', () => {
  const view = { state: 'running' as const, summary: 'Working', summaryIsClaim: false, steps: ['Wrote file A', 'Wrote file B'] }
  const { rerender } = render(<BlockCard block={buildBlock} view={view} />)
  expect(screen.getByText('Wrote file B')).toBeInTheDocument()
  expect(screen.queryByText('Wrote file A')).toBeNull()
  expect(screen.queryByRole('list')).toBeNull()
  rerender(<BlockCard expanded block={buildBlock} view={view} />)
  expect(screen.getByText('Wrote file A')).toBeInTheDocument()
  expect(screen.getByRole('list')).toBeInTheDocument()
})

test('a card with no steps at all shows no live line', () => {
  render(<BlockCard block={buildBlock} view={{ state: 'queued', summary: 'Waits', summaryIsClaim: false, steps: [] }} />)
  expect(screen.getByText('Waits')).toBeInTheDocument()
})

test('an empty summary still renders a readable result line', () => {
  render(<BlockCard block={buildBlock} view={{ state: 'passed', summary: '  ', summaryIsClaim: false }} />)
  expect(screen.getByText(strings.canvas.noResultLine)).toBeInTheDocument()
})

test('the fallback line is never attributed to the AI, even when summaryIsClaim is true', () => {
  render(<BlockCard block={buildBlock} view={{ state: 'passed', summary: '', summaryIsClaim: true }} />)
  expect(screen.getByText(strings.canvas.noResultLine)).toBeInTheDocument()
  expect(screen.queryByText(/AI says/i)).toBeNull()
})

// Regression guard: the domain layout must leave room between cards, or cables hide under them.
test('default lane spacing leaves at least 80px between card edges', () => {
  expect(LANE_SPACING - CARD_WIDTH).toBeGreaterThanOrEqual(80)
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

test('the model written inside the block is shown on its card', () => {
  const view = { state: 'queued' as const, summary: 'Waits', summaryIsClaim: false }
  const { rerender } = render(<BlockCard block={{ ...buildBlock, config: { model: 'big-model' } }} view={view} />)
  expect(screen.getByTestId('block-model-build')).toHaveTextContent('big-model')
  rerender(<BlockCard block={buildBlock} view={view} />)
  expect(screen.queryByTestId('block-model-build')).toBeNull() // no model chosen: nothing invented
  rerender(<BlockCard block={{ ...buildBlock, config: { model: '  ' } }} view={view} />)
  expect(screen.queryByTestId('block-model-build')).toBeNull()
})

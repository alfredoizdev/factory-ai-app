// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { NodeChange } from '@xyflow/react'
import { CARD_WIDTH } from '@/ui/canvas/BlockCard'
import { defaultGraph, LANE_SPACING, type Block, type Graph, type ValidationIssue } from '@/domain/graph'

type Captured = {
  onNodesChange?: (c: NodeChange[]) => void
  onNodeDragStop?: (e: unknown, node: { id: string; position: { x: number; y: number } }) => void
  nodes?: { id: string; position: { x: number; y: number } }[]
}
const captured: Captured = {}
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    // Real React Flow still renders; we only record what the canvas hands it.
    ReactFlow: (props: Captured & Record<string, unknown>) => {
      Object.assign(captured, props)
      return <actual.ReactFlow {...(props as object)} />
    },
  }
})

import { Canvas } from '@/ui/canvas/Canvas'
import { BlockCard } from '@/ui/canvas/BlockCard'
import { chainTo } from '@/ui/canvas/editing'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => vi.useRealTimers())

const edgesOf = () => (screen.getByTestId('canvas').getAttribute('data-edges') ?? '').split(',').filter(Boolean)
const posOf = (id: string) => captured.nodes!.find(n => n.id === id)!.position
const withDisabled = (g: Graph, ...ids: string[]): Graph => ({
  blocks: g.blocks.map(b => (ids.includes(b.id) ? { ...b, enabled: false } : b)),
})

test('an expanded card stays on the canvas and keeps its cables', () => {
  render(<Canvas graph={defaultGraph()} expandedId="build" />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByTestId('block-card-build')).toBeInTheDocument()
  expect(screen.getByTestId('breadcrumb')).toBeInTheDocument()
  expect(edgesOf()).toContain('build->tests')
  expect(edgesOf()).toContain('plan->build')
})

test('an expanded card shows where it sits in the chain', () => {
  render(<Canvas graph={defaultGraph()} expandedId="review" />)
  expect(screen.getByTestId('breadcrumb')).toHaveTextContent('Input › Plan › Build › Tests › Review')
})

test('the breadcrumb leaves out disabled blocks', () => {
  render(<Canvas graph={withDisabled(defaultGraph(), 'plan', 'tests')} expandedId="review" />)
  expect(screen.getByTestId('breadcrumb')).toHaveTextContent(/^Input › Build › Review$/)
})

test('chainTo lists enabled earlier stages, then the block itself', () => {
  const g = withDisabled(defaultGraph(), 'plan', 'tests')
  expect(chainTo(g, 'review')).toEqual(['Input', 'Build', 'Review'])
  expect(chainTo(g, 'input')).toEqual(['Input'])
  // A disabled block still shows where it sits, without counting disabled neighbours.
  expect(chainTo(g, 'tests')).toEqual(['Input', 'Build', 'Tests'])
  expect(chainTo(g, 'nope')).toEqual([])
})

test('neighbours to the right make room, and the ones to the left stay put', () => {
  const g = defaultGraph()
  render(<Canvas graph={g} expandedId="build" />)
  const stored = (id: string) => g.blocks.find(b => b.id === id)!.position
  expect(posOf('build')).toEqual(stored('build'))
  expect(posOf('plan')).toEqual(stored('plan'))
  expect(posOf('tests').x).toBeGreaterThan(stored('tests').x)
  expect(posOf('ship').x).toBeGreaterThan(stored('ship').x)
  // Nothing overlaps the grown card: the next lane starts after the expanded card's right edge.
  const grownWidth = posOf('tests').x - posOf('build').x - (LANE_SPACING - CARD_WIDTH)
  expect(grownWidth).toBeGreaterThan(CARD_WIDTH)
})

test('collapsing puts every neighbour back exactly where it is stored', () => {
  const g = defaultGraph()
  render(<Canvas graph={g} expandedId="build" />)
  expect(posOf('tests').x).not.toBe(3 * LANE_SPACING)
  fireEvent.click(screen.getByText('Collapse'))
  for (const b of g.blocks) expect(posOf(b.id)).toEqual(b.position)
  expect(screen.queryByTestId('breadcrumb')).toBeNull()
})

test('expanding does not rewrite stored positions, even when a save fires while expanded', async () => {
  vi.useFakeTimers()
  const g = defaultGraph()
  const save = vi.fn(async (_g: Graph): Promise<ValidationIssue[]> => [])
  render(<Canvas graph={g} save={save} />)
  fireEvent.click(screen.getByTestId('block-card-build'))
  expect(posOf('tests').x).toBeGreaterThan(g.blocks.find(b => b.id === 'tests')!.position.x)
  // Looking at a block saves nothing.
  await act(async () => void vi.advanceTimersByTime(2000))
  expect(save).not.toHaveBeenCalled()
  // An unrelated edit while expanded saves the original layout, not the pushed one.
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Builder' } })
  await act(async () => void vi.advanceTimersByTime(500))
  expect(save).toHaveBeenCalledTimes(1)
  const saved = save.mock.calls[0]![0]
  expect(saved.blocks.find(b => b.id === 'build')!.label).toBe('Builder')
  expect(saved.blocks.map(b => b.position)).toEqual(g.blocks.map(b => b.position))
})

test('dragging a pushed neighbour stores where the user put it, not the pushed spot', async () => {
  vi.useFakeTimers()
  const g = defaultGraph()
  const save = vi.fn(async (_g: Graph): Promise<ValidationIssue[]> => [])
  render(<Canvas graph={g} save={save} expandedId="build" />)
  const pushedX = posOf('tests').x
  const shift = pushedX - 3 * LANE_SPACING
  expect(shift).toBeGreaterThan(0)
  // The user drags the pushed card 10px right of where it is drawn.
  act(() => captured.onNodesChange!([{ id: 'tests', type: 'position', position: { x: pushedX + 10, y: 5 }, dragging: true }]))
  act(() => captured.onNodeDragStop!({}, { id: 'tests', position: { x: pushedX + 10, y: 5 } }))
  await act(async () => void vi.advanceTimersByTime(500))
  const saved = save.mock.calls[0]![0].blocks.find((b: Block) => b.id === 'tests')!
  expect(saved.position).toEqual({ x: 3 * LANE_SPACING + 10, y: 5 })
})

test('the live step list shows what the agent is doing now', () => {
  const build = defaultGraph().blocks.find(b => b.id === 'build')!
  render(
    <BlockCard
      expanded
      block={build}
      view={{ state: 'running', summary: 'Working', summaryIsClaim: false, steps: ['Found the button', 'Changed the colour', 'Writing the spinner'] }}
    />,
  )
  const items = screen.getAllByRole('listitem')
  expect(items.map(i => i.textContent)).toEqual(['Found the button', 'Changed the colour', 'Writing the spinner'])
})

test('a long step history shows the latest steps, numbered by their real position, and says what is hidden', () => {
  const build = defaultGraph().blocks.find(b => b.id === 'build')!
  const steps = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`)
  render(<BlockCard expanded block={build} view={{ state: 'running', summary: 'x', summaryIsClaim: false, steps }} />)
  const items = screen.getAllByRole('listitem').map(i => i.textContent)
  expect(items).toEqual(['step 7', 'step 8', 'step 9', 'step 10', 'step 11', 'step 12'])
  expect(screen.getByRole('list')).toHaveAttribute('start', '7')
  expect(screen.getByText('6 earlier steps are not shown')).toBeInTheDocument()
})

test('a short step history starts at 1 and claims nothing is hidden', () => {
  const build = defaultGraph().blocks.find(b => b.id === 'build')!
  render(<BlockCard expanded block={build} view={{ state: 'running', summary: 'x', summaryIsClaim: false, steps: ['a', 'b'] }} />)
  expect(screen.getByRole('list')).toHaveAttribute('start', '1')
  expect(screen.queryByText(/not shown/)).toBeNull()
})

test('an expanded card with no steps and no usage has no empty section', () => {
  const build = defaultGraph().blocks.find(b => b.id === 'build')!
  render(<BlockCard expanded block={build} view={{ state: 'queued', summary: 'x', summaryIsClaim: false }} />)
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.queryByText('Steps')).toBeNull()
})

test('selecting a card keeps its state colour and logs no React style error', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(<Canvas graph={defaultGraph()} />)
    const card = screen.getByTestId('block-card-build')
    const before = card.style.borderLeftColor
    expect(before).not.toBe('')
    fireEvent.click(card)
    fireEvent.click(card)
    expect(card.style.borderLeftColor).toBe(before)
    expect(card.style.borderLeftWidth).toBe('4px')
    expect(error).not.toHaveBeenCalled()
  } finally {
    error.mockRestore()
  }
})

test('an expanded card keeps the claim marker on an AI sentence and shows usage honestly', () => {
  const review = defaultGraph().blocks.find(b => b.id === 'review')!
  render(
    <BlockCard
      expanded
      block={review}
      breadcrumb={['Input', 'Review']}
      view={{ state: 'passed', summary: 'Looks fine', summaryIsClaim: true, usage: { tokens: null, costCents: null } }}
    />,
  )
  expect(screen.getByText(/AI says/)).toBeInTheDocument()
  expect(screen.getAllByText('Not reported')).toHaveLength(2)
})

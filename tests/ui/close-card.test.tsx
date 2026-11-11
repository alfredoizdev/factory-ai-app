// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { defaultGraph } from '@/domain/graph'
import { Canvas } from '@/ui/canvas/Canvas'
import { BlockInspector } from '@/ui/canvas/BlockInspector'
import { strings } from '@/ui/strings'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const done = defaultGraph().blocks.map(b => ({ blockId: b.id, state: 'passed' as const, summary: 'ok', summaryIsClaim: false, steps: [] }))

function renderRun() {
  render(<Canvas graph={defaultGraph()} runBlocks={defaultGraph().blocks} nodeRuns={done} />)
}

// React Flow hides nodes it has not measured, and jsdom measures nothing, so card buttons are found by text.
async function openPlan() {
  fireEvent.click(await screen.findByTestId('node-plan'))
  expect(screen.queryByText(strings.editing.inspectorEmpty)).toBeNull()
  expect(screen.getByText(strings.canvas.close, { selector: 'button' })).toBeInTheDocument()
}

function expectBackToStart() {
  expect(screen.getByText(strings.editing.inspectorEmpty)).toBeInTheDocument()
  expect(screen.queryByText(strings.canvas.close, { selector: 'button' })).toBeNull()
}

test('a card opened by a click has a Close button that returns to the first view', async () => {
  renderRun()
  await openPlan()
  fireEvent.click(screen.getByText(strings.canvas.close, { selector: 'button' }))
  expectBackToStart()
})

test('Escape closes the opened card', async () => {
  renderRun()
  await openPlan()
  act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
  expectBackToStart()
})

test('Escape inside a text field does not close the card', async () => {
  renderRun()
  await openPlan()
  fireEvent.keyDown(screen.getByLabelText('Model'), { key: 'Escape' })
  expect(screen.queryByText(strings.editing.inspectorEmpty)).toBeNull()
})

test('the block settings have their own close button', async () => {
  renderRun()
  await openPlan()
  fireEvent.click(screen.getByRole('button', { name: strings.editing.closeSettings }))
  expectBackToStart()
})

test('while a run is on screen the model field says changes apply to the next run', () => {
  const block = defaultGraph().blocks.find(b => b.id === 'build')!
  const { rerender } = render(<BlockInspector block={block} onChange={() => {}} />)
  expect(screen.queryByText(strings.editing.appliesNextRun)).toBeNull()
  rerender(<BlockInspector block={block} onChange={() => {}} runOnScreen />)
  expect(screen.getByText(strings.editing.appliesNextRun)).toBeInTheDocument()
})

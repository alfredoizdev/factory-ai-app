// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import type { NodeChange } from '@xyflow/react'
import { defaultGraph, type Graph, type ValidationIssue } from '@/domain/graph'

// React Flow cannot measure or drag in jsdom, so capture its props and drive the same callbacks it would.
type Captured = {
  onNodesChange?: (c: NodeChange[]) => void
  onNodeDragStop?: (e: unknown, node: { id: string; position: { x: number; y: number } }) => void
  nodes?: { id: string; position: { x: number; y: number } }[]
  nodesDraggable?: boolean
  nodesConnectable?: boolean
  onConnect?: unknown
}
const captured: Captured = {}
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ReactFlow: (props: Captured) => {
      Object.assign(captured, props)
      return null
    },
  }
})

import { Canvas } from '@/ui/canvas/Canvas'

afterEach(() => vi.useRealTimers())

test('dragging a block persists its new position through the debounced save', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_g: Graph): Promise<ValidationIssue[]> => [])
  render(<Canvas graph={defaultGraph()} save={save} />)

  act(() =>
    captured.onNodesChange!([{ id: 'build', type: 'position', position: { x: 40, y: 12 }, dragging: true }]),
  )
  // The card follows the pointer while dragging, but nothing is saved mid-drag.
  expect(captured.nodes!.find(n => n.id === 'build')!.position).toEqual({ x: 40, y: 12 })
  act(() => void vi.advanceTimersByTime(1000))
  expect(save).not.toHaveBeenCalled()

  act(() => captured.onNodeDragStop!({}, { id: 'build', position: { x: 40, y: 12 } }))
  await act(async () => void vi.advanceTimersByTime(500))
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0].blocks.find(b => b.kind === 'build')!.position).toEqual({ x: 40, y: 12 })
})

test('the canvas is draggable but offers no way to draw or change a connection', () => {
  render(<Canvas graph={defaultGraph()} />)
  expect(captured.nodesDraggable).toBe(true)
  expect(captured.nodesConnectable).toBe(false)
  expect(captured.onConnect).toBeUndefined()
})

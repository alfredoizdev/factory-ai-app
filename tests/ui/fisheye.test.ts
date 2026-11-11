import { defaultGraph, type Block } from '@/domain/graph'
import { CARD_WIDTH, SPINE_WIDTH } from '@/ui/canvas/BlockCard'
import { autoFocus, fisheyeLayout } from '@/ui/canvas/fisheye'
import type { NodeState } from '@/domain/states'

const blocks = defaultGraph().blocks
const widthOf = (id: string, placed: Map<string, { collapsed: boolean }>) =>
  placed.get(id)!.collapsed ? SPINE_WIDTH : CARD_WIDTH

test('the focus and its two neighbours stay panels; everything else collapses', () => {
  const placed = fisheyeLayout(blocks, 'tests')
  const full = blocks.filter(b => !placed.get(b.id)!.collapsed).map(b => b.id)
  expect(full).toEqual(['build', 'tests', 'review'])
})

test('every block is placed, and they never overlap, so none is lost off the lane', () => {
  const placed = fisheyeLayout(blocks, 'tests')
  expect(placed.size).toBe(blocks.length)
  const lane = blocks.map(b => ({ id: b.id, x: placed.get(b.id)!.x })).sort((a, b) => a.x - b.x)
  // Reading left to right still follows the order of the stages.
  expect(lane.map(l => l.id)).toEqual(blocks.map(b => b.id))
  for (const [i, here] of lane.entries()) {
    const next = lane[i + 1]
    if (next) expect(next.x).toBeGreaterThanOrEqual(here.x + widthOf(here.id, placed))
  }
})

test('the whole lane is narrower than the eight panels it replaces', () => {
  const placed = fisheyeLayout(blocks, 'tests')
  const right = Math.max(...blocks.map(b => placed.get(b.id)!.x + widthOf(b.id, placed)))
  expect(right).toBeLessThan(blocks.length * CARD_WIDTH)
})

test('a block that must stay full does not collapse, however far it is from the focus', () => {
  const placed = fisheyeLayout(blocks, 'input', new Set(['ship']))
  expect(placed.get('ship')!.collapsed).toBe(false)
  expect(placed.get('approve')!.collapsed).toBe(true)
})

test('blocks of one stage share a column and stack downwards', () => {
  const second: Block = { ...blocks.find(b => b.kind === 'review')!, id: 'review-1', position: { x: 0, y: 0 } }
  const placed = fisheyeLayout([...blocks, second], 'review')
  expect(placed.get('review-1')!.x).toBe(placed.get('review')!.x)
  expect(placed.get('review-1')!.y).toBeGreaterThan(placed.get('review')!.y)
})

test('with no focus at all the lane opens on its first block', () => {
  const placed = fisheyeLayout(blocks, null)
  expect(placed.get('input')!.collapsed).toBe(false)
  expect(placed.get('build')!.collapsed).toBe(true)
})

const lane = (states: Partial<Record<string, NodeState>>) =>
  blocks.map(b => ({ id: b.id, state: states[b.id] ?? ('queued' as NodeState) }))

test('whatever is running claims the focus', () => {
  expect(autoFocus(lane({ input: 'passed', plan: 'passed', build: 'running' }))).toBe('build')
})

test('a block waiting for a person outranks a finished one, and a failure outranks a queue', () => {
  expect(autoFocus(lane({ input: 'passed', human: 'waiting_approval' }))).toBe('human')
  expect(autoFocus(lane({ input: 'passed', tests: 'failed' }))).toBe('tests')
})

test('with nothing happening the focus is how far the run got', () => {
  expect(autoFocus(lane({ input: 'passed', plan: 'passed', build: 'passed' }))).toBe('build')
})

test('a run that has not started opens on its first block, and an empty lane on nothing', () => {
  expect(autoFocus(lane({}))).toBe('input')
  expect(autoFocus([])).toBeNull()
})

test('a block the run does not contain is never chosen as the focus', () => {
  const ordered = [{ id: 'input', state: 'passed' as NodeState }, { id: 'extra', state: null }]
  expect(autoFocus(ordered)).toBe('input')
})

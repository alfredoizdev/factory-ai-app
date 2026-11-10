import { expect, test } from 'vitest'
import {
  defaultGraph,
  derivedEdges,
  validateGraph,
  type BlockKind,
  type Graph,
} from '@/domain/graph'

function kindOf(g: Graph, id: string): BlockKind | undefined {
  return g.blocks.find(b => b.id === id)?.kind
}

// Replaces the review block with n reviewers. The tests block is dropped so that
// Build connects directly to Review, which is what the fan-out assertions inspect.
function withReviewers(g: Graph, n: number): Graph {
  const template = g.blocks.find(b => b.kind === 'review')!
  const others = g.blocks.filter(b => b.kind !== 'review' && b.kind !== 'tests')
  const reviewers = Array.from({ length: n }, (_, i) => ({
    ...template,
    id: `review-${i + 1}`,
  }))
  return { blocks: [...others, ...reviewers] }
}

test('edges are derived from stage order, not stored', () => {
  const g = defaultGraph()
  const e = derivedEdges(g)
  expect(e.some(x => x.kind === 'return')).toBe(true)
  expect(JSON.stringify(g)).not.toContain('"edges"')
})

test('disabling a middle block reconnects its neighbours', () => {
  const g = defaultGraph()
  const tests = g.blocks.find(b => b.kind === 'tests')!
  tests.enabled = false
  const ids = derivedEdges(g).map(e => `${kindOf(g, e.from)}->${kindOf(g, e.to)}`)
  expect(ids).toContain('build->review')
  expect(ids.some(s => s.includes('tests'))).toBe(false)
})

test('four review blocks fan out from build and converge on approve', () => {
  const g = withReviewers(defaultGraph(), 4)
  const e = derivedEdges(g).filter(x => x.kind === 'normal')
  expect(e.filter(x => kindOf(g, x.from) === 'build' && kindOf(g, x.to) === 'review')).toHaveLength(4)
  expect(e.filter(x => kindOf(g, x.to) === 'approve')).toHaveLength(4)
})

test('removing a required block is a validation issue', () => {
  const g = { blocks: defaultGraph().blocks.filter(b => b.kind !== 'build') }
  expect(validateGraph(g).map(i => i.code)).toContain('missing_required_stage')
})

test('a second build block is rejected as a duplicate singleton', () => {
  const g = defaultGraph()
  g.blocks.push({ ...g.blocks.find(b => b.kind === 'build')!, id: 'dup' })
  expect(validateGraph(g).map(i => i.code)).toContain('duplicate_singleton')
})

test('the default graph is valid', () => {
  expect(validateGraph(defaultGraph())).toEqual([])
})

test('disabling a required block is flagged', () => {
  const g = defaultGraph()
  g.blocks.find(b => b.kind === 'human')!.enabled = false
  expect(validateGraph(g).map(i => i.code)).toContain('disabled_required')
})

test('exactly one return edge runs from approve to build', () => {
  const g = withReviewers(defaultGraph(), 3)
  const ret = derivedEdges(g).filter(x => x.kind === 'return')
  expect(ret).toHaveLength(1)
  expect(kindOf(g, ret[0]!.from)).toBe('approve')
  expect(kindOf(g, ret[0]!.to)).toBe('build')
})

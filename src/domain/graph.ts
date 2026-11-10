import { strings } from '@/ui/strings'

export type BlockKind =
  | 'input'
  | 'plan'
  | 'build'
  | 'tests'
  | 'review'
  | 'approve'
  | 'human'
  | 'ship'

export type Block = {
  id: string
  kind: BlockKind
  label: string
  enabled: boolean
  config: Record<string, unknown>
  position: { x: number; y: number }
}

// Edges are never stored: they are computed from the blocks by derivedEdges().
export type Graph = { blocks: Block[] }

export type Edge = { from: string; to: string; kind: 'normal' | 'return' }

export type ValidationIssue = {
  blockId: string | null
  code: 'missing_required_stage' | 'duplicate_singleton' | 'disabled_required' | 'unconfigured'
  message: string
}

export const STAGE_ORDER: readonly BlockKind[] = [
  'input',
  'plan',
  'build',
  'tests',
  'review',
  'approve',
  'human',
  'ship',
]

export const SINGLETON_KINDS: readonly BlockKind[] = ['input', 'plan', 'build', 'approve', 'human', 'ship']

export const REQUIRED_KINDS: readonly BlockKind[] = ['input', 'build', 'human']

const LANE_SPACING = 220

export function defaultGraph(): Graph {
  return {
    blocks: STAGE_ORDER.map((kind, i) => ({
      id: kind,
      kind,
      label: strings.blocks[kind],
      enabled: true,
      config: {},
      position: { x: i * LANE_SPACING, y: 0 },
    })),
  }
}

export function derivedEdges(graph: Graph): Edge[] {
  // Enabled blocks grouped by stage, skipping stages with none enabled.
  const stages = STAGE_ORDER.map(kind => graph.blocks.filter(b => b.kind === kind && b.enabled)).filter(
    group => group.length > 0,
  )

  const edges: Edge[] = []
  stages.forEach((group, i) => {
    const next = stages[i + 1]
    if (!next) return
    for (const from of group) {
      for (const to of next) edges.push({ from: from.id, to: to.id, kind: 'normal' })
    }
  })

  const approve = graph.blocks.find(b => b.kind === 'approve' && b.enabled)
  const build = graph.blocks.find(b => b.kind === 'build' && b.enabled)
  if (approve && build) edges.push({ from: approve.id, to: build.id, kind: 'return' })

  return edges
}

export function validateGraph(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const kind of REQUIRED_KINDS) {
    const ofKind = graph.blocks.filter(b => b.kind === kind)
    const label = strings.blocks[kind]
    if (ofKind.length === 0) {
      issues.push({
        blockId: null,
        code: 'missing_required_stage',
        message: strings.validation.missingRequired(label),
      })
    } else if (!ofKind.some(b => b.enabled)) {
      for (const b of ofKind) {
        issues.push({
          blockId: b.id,
          code: 'disabled_required',
          message: strings.validation.disabledRequired(label),
        })
      }
    }
  }

  for (const kind of SINGLETON_KINDS) {
    const ofKind = graph.blocks.filter(b => b.kind === kind)
    if (ofKind.length > 1) {
      for (const b of ofKind.slice(1)) {
        issues.push({
          blockId: b.id,
          code: 'duplicate_singleton',
          message: strings.validation.duplicateSingleton(strings.blocks[kind]),
        })
      }
    }
  }

  return issues
}

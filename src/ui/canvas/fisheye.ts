import { STAGE_ORDER, type Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'
import { CARD_MIN_HEIGHT, CARD_WIDTH, SPINE_WIDTH } from './BlockCard'

/** Gaps between columns. Two panels need more air between them than two spines do. */
const GAP = { bothSpine: 18, mixed: 44, bothFull: 64 } as const

/** Vertical pitch for two blocks that share a stage. */
const ROW_PITCH = CARD_MIN_HEIGHT + 40

export type Placement = { x: number; y: number; collapsed: boolean }

/** The stages that actually hold blocks, left to right. Blocks of one stage share a column. */
function stagesOf(blocks: readonly Block[]): Block[][] {
  return STAGE_ORDER.map(kind => blocks.filter(b => b.kind === kind)).filter(group => group.length > 0)
}

/**
 * Lays the lane out around one block: that block's stage and the two beside it stay full panels, and every
 * other stage collapses to a spine. This is what makes eight readable blocks fit on one screen without
 * breaking the left-to-right reading or hiding any of them.
 *
 * `alwaysFull` holds blocks that must not collapse whatever the focus is — a block carrying a validation
 * message, because a collapsed card has nowhere to show it.
 */
export function fisheyeLayout(
  blocks: readonly Block[],
  focusId: string | null,
  alwaysFull: ReadonlySet<string> = new Set(),
): Map<string, Placement> {
  const stages = stagesOf(blocks)
  const focusStage = stages.findIndex(group => group.some(b => b.id === focusId))
  const centre = focusStage === -1 ? 0 : focusStage
  const isFull = (i: number) => Math.abs(i - centre) <= 1 || stages[i]!.some(b => alwaysFull.has(b.id))

  const placed = new Map<string, Placement>()
  let x = 0
  stages.forEach((group, i) => {
    const collapsed = !isFull(i)
    for (const [row, block] of group.entries()) placed.set(block.id, { x, y: row * ROW_PITCH, collapsed })
    if (i === stages.length - 1) return
    const here = isFull(i)
    const there = isFull(i + 1)
    const gap = here && there ? GAP.bothFull : !here && !there ? GAP.bothSpine : GAP.mixed
    x += (collapsed ? SPINE_WIDTH : CARD_WIDTH) + gap
  })
  return placed
}

/** States that pull the focus to themselves, most urgent first. */
const CLAIMS_FOCUS: readonly NodeState[] = ['running', 'waiting_approval', 'blocked', 'failed']

/**
 * Which block the canvas should open on its own: whatever is happening, or, when nothing is, how far the
 * run got. `ordered` must be in stage order. A null state means the run does not contain that block.
 */
export function autoFocus(ordered: readonly { id: string; state: NodeState | null }[]): string | null {
  for (const state of CLAIMS_FOCUS) {
    const hit = ordered.find(o => o.state === state)
    if (hit) return hit.id
  }
  const furthest = [...ordered].reverse().find(o => o.state !== null && o.state !== 'queued')
  return furthest?.id ?? ordered[0]?.id ?? null
}

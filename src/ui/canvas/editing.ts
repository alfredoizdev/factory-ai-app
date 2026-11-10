import { LANE_SPACING, SINGLETON_KINDS, STAGE_ORDER, type Block, type BlockKind, type Graph } from '@/domain/graph'
import { strings } from '@/ui/strings'

/** Vertical gap between blocks of the same stage; taller than a card so siblings never overlap. */
export const ROW_SPACING = 160

/**
 * The first block of a kind keeps the bare kind as its id (the rest of the app addresses cards that way);
 * later ones are suffixed. Checked against every id currently in the graph, so it cannot collide.
 */
export function nextBlockId(graph: Graph, kind: BlockKind): string {
  const taken = new Set(graph.blocks.map(b => b.id))
  if (!taken.has(kind)) return kind
  let n = 1
  while (taken.has(`${kind}-${n}`)) n++
  return `${kind}-${n}`
}

/** Kinds that are legal to add right now: a singleton already on the canvas is not offered. */
export function addableKinds(graph: Graph): BlockKind[] {
  return STAGE_ORDER.filter(kind => !SINGLETON_KINDS.includes(kind) || !graph.blocks.some(b => b.kind === kind))
}

export function addBlock(graph: Graph, kind: BlockKind): Graph {
  if (!addableKinds(graph).includes(kind)) return graph
  const sameStage = graph.blocks.filter(b => b.kind === kind).length
  const block: Block = {
    id: nextBlockId(graph, kind),
    kind,
    label: strings.blocks[kind],
    enabled: true,
    config: {},
    position: { x: STAGE_ORDER.indexOf(kind) * LANE_SPACING, y: sameStage * ROW_SPACING },
  }
  return { blocks: [...graph.blocks, block] }
}

export function updateBlock(graph: Graph, block: Block): Graph {
  return { blocks: graph.blocks.map(b => (b.id === block.id ? block : b)) }
}

export function moveBlock(graph: Graph, id: string, position: { x: number; y: number }): Graph {
  return { blocks: graph.blocks.map(b => (b.id === id ? { ...b, position } : b)) }
}

/** The only block of a required kind cannot be removed: the editor never offers a way to lose a stage. */
export function canRemove(graph: Graph, block: Block): boolean {
  const required = ['input', 'build', 'human'].includes(block.kind)
  return !required || graph.blocks.some(b => b.kind === block.kind && b.id !== block.id)
}

export function removeBlock(graph: Graph, id: string): Graph {
  return { blocks: graph.blocks.filter(b => b.id !== id) }
}

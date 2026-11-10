'use client'

import { Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { derivedEdges, type Block, type Graph } from '@/domain/graph'
import { theme } from '@/ui/theme'
import { strings } from '@/ui/strings'
import { BlockCard, type NodeRunView } from './BlockCard'

export type { NodeRunView }

const RETURN_OUT = 'return-out'
const RETURN_IN = 'return-in'

type CardData = { block: Block; view: NodeRunView; expanded: boolean }
type CardNode = Node<CardData, 'block'>

function BlockNode({ data }: NodeProps<CardNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <BlockCard block={data.block} view={data.view} expanded={data.expanded} selected={data.expanded} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {/* Bottom handles carry the return cable so it loops beneath the lane. */}
      <Handle id={RETURN_OUT} type="source" position={Position.Bottom} isConnectable={false} />
      <Handle id={RETURN_IN} type="target" position={Position.Bottom} isConnectable={false} />
    </>
  )
}

const nodeTypes = { block: BlockNode }

export function Canvas({
  graph,
  nodeRuns,
  onSelect,
  expandedId,
}: {
  graph: Graph
  nodeRuns: NodeRunView[]
  onSelect: (id: string) => void
  expandedId: string | null
}) {
  const runById = new Map(nodeRuns.map(r => [r.blockId, r]))

  // A block with no view is not drawn: a card's state must come from data, never a default.
  const nodes: CardNode[] = graph.blocks.flatMap(block => {
    const view = runById.get(block.id)
    if (!view) return []
    return [
      {
        id: block.id,
        type: 'block' as const,
        position: block.position,
        data: { block, view, expanded: expandedId === block.id },
      },
    ]
  })

  const edges: Edge[] = derivedEdges(graph).map(e =>
    e.kind === 'return'
      ? {
          id: `${e.from}->${e.to}:return`,
          source: e.from,
          target: e.to,
          // Both ends use bottom handles, so the path drops below the lane and back up.
          sourceHandle: RETURN_OUT,
          targetHandle: RETURN_IN,
          type: 'smoothstep',
          label: strings.canvas.returnEdge,
          style: { stroke: theme.failed, strokeWidth: 2, strokeDasharray: '6 4' },
          labelStyle: { fill: theme.failed },
          markerEnd: { type: MarkerType.ArrowClosed, color: theme.failed },
        }
      : {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          style: { stroke: theme.border, strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: theme.border },
        },
  )

  return (
    <div style={{ width: '100%', height: '100%', background: theme.bg }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background color={theme.border} />
      </ReactFlow>
    </div>
  )
}

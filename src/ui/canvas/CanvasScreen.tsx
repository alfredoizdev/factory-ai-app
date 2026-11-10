'use client'

import { useState } from 'react'
import type { Graph } from '@/domain/graph'
import { Canvas, type NodeRunView } from './Canvas'

// Holds the only interactive state this task allows: which card is expanded.
export function CanvasScreen({ graph, nodeRuns }: { graph: Graph; nodeRuns: NodeRunView[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  return (
    <div style={{ height: '100vh' }}>
      <Canvas
        graph={graph}
        nodeRuns={nodeRuns}
        expandedId={expandedId}
        onSelect={id => setExpandedId(current => (current === id ? null : id))}
      />
    </div>
  )
}

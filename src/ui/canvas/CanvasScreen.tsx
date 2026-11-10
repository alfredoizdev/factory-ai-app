'use client'

import type { Graph, ValidationIssue } from '@/domain/graph'
import { Canvas } from './Canvas'

export function CanvasScreen({ workflowId, graph }: { workflowId: string; graph: Graph }) {
  // keepalive lets a save started as the page closes still complete.
  async function save(next: Graph): Promise<ValidationIssue[]> {
    const res = await fetch(`/api/workflows/${workflowId}/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
      keepalive: true,
    })
    if (!res.ok) throw new Error(`Saving the draft failed (${res.status})`)
    return ((await res.json()) as { issues: ValidationIssue[] }).issues
  }

  return (
    <div style={{ height: '100vh' }}>
      <Canvas graph={graph} save={save} />
    </div>
  )
}

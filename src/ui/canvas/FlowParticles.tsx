'use client'

import { Position, getBezierPath, useInternalNode } from '@xyflow/react'
import type { Edge } from '@/domain/graph'
import { theme } from '@/ui/theme'
import { CARD_WIDTH } from './BlockCard'

const DOTS = 3
const DURATION_S = 2.4
/** Used only until xyflow has measured the card; a collapsed card is roughly this tall. */
const FALLBACK_HEIGHT = 120

/**
 * Dots travelling a cable. Rendered only while `active` (the target block is running); the caller also drops
 * it under reduced motion, because a dot that does not move would be a lie about the cable.
 */
export function FlowParticles({ edge, path, active }: { edge: Edge; path: string; active: boolean }) {
  if (!active) return null
  return (
    <g data-testid={`particles-${edge.from}->${edge.to}`} aria-hidden="true" style={{ pointerEvents: 'none' }}>
      {Array.from({ length: DOTS }, (_, i) => (
        <circle key={i} r={3.5} fill={theme.running} style={{ filter: `drop-shadow(0 0 4px ${theme.running})` }}>
          <animateMotion dur={`${DURATION_S}s`} begin={`${(i * DURATION_S) / DOTS}s`} repeatCount="indefinite" path={path} />
        </circle>
      ))}
    </g>
  )
}

export type Cable = { edge: Edge; from: { x: number; y: number }; to: { x: number; y: number } }

/** Same geometry as xyflow's default cable: right-middle of the source to left-middle of the target. */
function CableParticles({ cable }: { cable: Cable }) {
  const source = useInternalNode(cable.edge.from)
  const target = useInternalNode(cable.edge.to)
  const sx = cable.from.x + (source?.measured.width ?? CARD_WIDTH)
  const sy = cable.from.y + (source?.measured.height ?? FALLBACK_HEIGHT) / 2
  const ty = cable.to.y + (target?.measured.height ?? FALLBACK_HEIGHT) / 2
  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: Position.Right,
    targetX: cable.to.x,
    targetY: ty,
    targetPosition: Position.Left,
  })
  return <FlowParticles edge={cable.edge} path={path} active />
}

/** Lives in the viewport, so it pans and zooms with the nodes. Never takes a pointer event. */
export function ParticleLayer({ cables }: { cables: Cable[] }) {
  return (
    <svg
      aria-hidden="true"
      data-testid="particle-layer"
      width={1}
      height={1}
      style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none' }}
    >
      {cables.map(c => (
        <CableParticles key={`${c.edge.from}->${c.edge.to}`} cable={c} />
      ))}
    </svg>
  )
}

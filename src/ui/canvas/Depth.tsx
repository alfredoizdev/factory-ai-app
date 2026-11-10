'use client'

import type { Ref } from 'react'
import { theme } from '@/ui/theme'

/** Spacing of the floor grid, in px on the floor plane. */
const GRID = 64

/**
 * The decorative floor under the canvas: a perspective grid plus ambient glow. It never carries state,
 * never takes a click, and is hidden from assistive tech. `floorRef` is moved by the canvas on pan (parallax).
 */
export function Depth({ floorRef }: { floorRef?: Ref<HTMLDivElement> }) {
  return (
    <div
      aria-hidden="true"
      data-testid="depth"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}
    >
      <div
        data-testid="depth-ambient"
        style={{ position: 'absolute', inset: 0, background: theme.ambient, pointerEvents: 'none' }}
      />
      <div style={{ position: 'absolute', inset: 0, perspective: 700, perspectiveOrigin: '50% 0%', pointerEvents: 'none' }}>
        <div
          ref={floorRef}
          aria-hidden="true"
          data-testid="depth-floor"
          style={{
            position: 'absolute',
            left: '-100%',
            width: '300%',
            top: '15%',
            height: '300%',
            transformOrigin: '50% 0%',
            transform: 'rotateX(62deg)',
            backgroundImage: `linear-gradient(${theme.floorLine} 1px, transparent 1px), linear-gradient(90deg, ${theme.floorLine} 1px, transparent 1px)`,
            backgroundSize: `${GRID}px ${GRID}px`,
            // Fade to nothing towards the horizon so the grid reads as a floor, not a wall of lines.
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 35%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 35%)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  )
}

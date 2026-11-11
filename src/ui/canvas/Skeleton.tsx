'use client'

import type { CSSProperties } from 'react'
import { theme } from '@/ui/theme'

/** A grey shape that shimmers: where content will be, the size it will be, so nothing moves when it arrives. */
export function Bone({ width = '100%', height = 12, radius = 6, style }: { width?: number | string; height?: number; radius?: number; style?: CSSProperties }) {
  return <div aria-hidden="true" className="factory-skeleton" style={{ width, height, borderRadius: radius, ...style }} />
}

/** The lane while a task loads: narrow cards for the finished steps, wider ones for the last few. */
export function LaneSkeleton({ count }: { count: number }) {
  const wide = Math.min(2, count)
  return (
    <div
      data-testid="lane-skeleton"
      aria-busy="true"
      style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, pointerEvents: 'none', paddingRight: 360 }}
    >
      {Array.from({ length: count }, (_, i) => {
        const isWide = i >= count - wide
        return (
          <div
            key={i}
            style={{ width: isWide ? 230 : 46, height: 180, borderRadius: 12, border: `1px solid ${theme.border}`, background: theme.card, padding: isWide ? 14 : 8, display: 'grid', alignContent: 'start', gap: 10 }}
          >
            <Bone width={isWide ? '55%' : '100%'} height={isWide ? 16 : 22} />
            {isWide && (
              <>
                <Bone width="35%" height={9} />
                <Bone height={11} />
                <Bone width="80%" height={11} />
                <Bone height={48} radius={8} />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The command card while a task loads: a heading, a few lines, a box and a button, where they will be. */
export function CardSkeleton() {
  return (
    <div data-testid="card-skeleton" aria-busy="true" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Bone width={30} height={30} radius={8} />
        <div style={{ flex: 1, display: 'grid', gap: 6 }}>
          <Bone width="40%" height={14} />
          <Bone width="75%" height={10} />
        </div>
      </div>
      <Bone height={10} />
      <Bone width="85%" height={10} />
      <Bone height={96} radius={10} />
      <Bone height={38} radius={8} />
    </div>
  )
}

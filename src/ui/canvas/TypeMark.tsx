import type { ReactNode } from 'react'
import type { BlockKind } from '@/domain/graph'

/**
 * One drawing per kind of block, in a single 16px stroke set so the eight read as one family.
 * Each says what the stage DOES, not what it is called: an arrow into a line for Input, a wrench for
 * Build, a tick in a box for Tests, a magnifier for Review, a person for the human check.
 */
const PATHS: Record<BlockKind, ReactNode> = {
  input: <path d="M2 8h8M7 5l3 3-3 3M12 2v12" />,
  plan: <path d="M3 4h10M3 8h10M3 12h6" />,
  build: <path d="M2.5 5.5l3-3 8 8-3 3zM9 3l1.5-1.5 3.5 3.5L12.5 6.5" />,
  tests: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" />
      <path d="M3 8l2.5 2.5L9 6" />
    </>
  ),
  review: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  approve: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.2l2.2 2.2L11 6.4" />
    </>
  ),
  human: (
    <>
      <circle cx="8" cy="5" r="2.6" />
      <path d="M3 14c0-2.8 2.2-4.6 5-4.6s5 1.8 5 4.6" />
    </>
  ),
  ship: (
    <>
      <path d="M8 13V3M8 3l4 4M8 3L4 7" />
      <path d="M2.5 13.5h11" />
    </>
  ),
}

/**
 * The square that carries a block's drawing, tinted with the state colour. Decorative: the block's name is
 * right beside it, so the icon never has to be understood on its own and is hidden from assistive tech.
 */
export function TypeMark({ kind, colour, size = 28 }: { kind: BlockKind; colour: string; size?: number }) {
  const glyph = Math.round(size * 0.54)
  return (
    <span
      aria-hidden="true"
      data-testid={`type-mark-${kind}`}
      style={{
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: Math.round(size * 0.29),
        display: 'grid',
        placeItems: 'center',
        background: `color-mix(in srgb, ${colour} 13%, transparent)`,
        border: `1px solid color-mix(in srgb, ${colour} 28%, transparent)`,
        color: colour,
      }}
    >
      <svg
        viewBox="0 0 16 16"
        width={glyph}
        height={glyph}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'block' }}
      >
        {PATHS[kind]}
      </svg>
    </span>
  )
}

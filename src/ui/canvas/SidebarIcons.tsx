import type { ReactNode } from 'react'

// The rail's icons, drawn in the same 16px stroke set as the block marks so the two read as one family.
const PATHS = {
  run: <path d="M5 3.5v9l7-4.5z" />,
  add: <path d="M8 3v10M3 8h10" />,
  settings: (
    <>
      <path d="M3 4.5h10M3 11.5h10" />
      <circle cx="6" cy="4.5" r="1.6" />
      <circle cx="10.5" cy="11.5" r="1.6" />
    </>
  ),
  collapse: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  expand: <path d="M6 3.5L10.5 8 6 12.5" />,
} satisfies Record<string, ReactNode>

export type SidebarIconName = keyof typeof PATHS

export function SidebarIcon({ name, size = 16 }: { name: SidebarIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      {PATHS[name]}
    </svg>
  )
}

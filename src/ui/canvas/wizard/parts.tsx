'use client'

import type { CSSProperties, ReactNode } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

// Small pieces every screen of the "New project" wizard shares.

export const field: CSSProperties = { padding: '10px 12px', background: theme.bg, color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 8, fontSize: 14, minWidth: 0 }
export const mono: CSSProperties = { fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }
export const hint: CSSProperties = { fontSize: 13, lineHeight: 1.45, color: theme.dim, margin: 0 }
export const lead: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 700 }

export const button = (primary: boolean, busy = false): CSSProperties => ({
  padding: '8px 14px',
  borderRadius: 8,
  border: `1px solid ${primary ? theme.running : theme.border}`,
  background: primary ? theme.running : theme.card,
  color: primary ? '#fff' : 'inherit',
  fontWeight: 600,
  cursor: busy ? 'wait' : 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
})

/** A tile or card the person picks: outlined in the accent colour when chosen. */
export const choice = (picked: boolean): CSSProperties => ({
  border: `${picked ? 2 : 1}px solid ${picked ? theme.running : theme.border}`,
  background: picked ? 'rgba(59, 130, 246, 0.12)' : theme.bg,
  // One pixel less padding when picked, so the thicker outline does not move what is inside.
  margin: picked ? 0 : 1,
  borderRadius: 10,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
})

/** Where the person is: every step by name, the current one marked. */
export function StepBar({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol data-testid="wizard-steps" aria-label={strings.wizard.stepOf(current + 1, steps.length)} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: 0, padding: 0, listStyle: 'none', fontSize: 12 }}>
      {steps.map((name, i) => (
        <li
          key={name}
          aria-current={i === current ? 'step' : undefined}
          style={{
            padding: '3px 10px',
            borderRadius: 999,
            border: `1px solid ${i === current ? theme.running : theme.border}`,
            background: i === current ? 'rgba(59, 130, 246, 0.18)' : 'transparent',
            color: i === current ? '#e6e9ef' : theme.dim,
            fontWeight: i === current ? 700 : 500,
          }}
        >
          {i + 1} {name}
        </li>
      ))}
    </ol>
  )
}

export type Level = 'ok' | 'optional' | 'required'
export const LEVEL_COLOR: Record<Level, string> = { ok: theme.passed, optional: theme.waiting, required: theme.failed }

/** Found (a tick), missing but not needed (a warning sign), or required and missing (a cross in a circle). */
export function LevelIcon({ level, size = 16 }: { level: Level; size?: number }) {
  return (
    <svg data-level={level} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={LEVEL_COLOR[level]} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {level === 'ok' && <path d="M5 12.5l4.5 4.5L19 7.5" />}
      {level === 'optional' && (
        <>
          <path d="M12 3.5L2.5 20h19L12 3.5z" strokeWidth="2" />
          <path d="M12 10v4.5M12 17.2v.1" />
        </>
      )}
      {level === 'required' && (
        <>
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </>
      )}
    </svg>
  )
}

export function Row({ level, label, value }: { level: Level; label: string; value: ReactNode }) {
  return (
    <div data-level={level} style={{ display: 'grid', gridTemplateColumns: '18px minmax(90px, 170px) minmax(0, 1fr)', gap: 10, alignItems: 'center' }}>
      <LevelIcon level={level} />
      <span style={{ color: theme.dim }}>{label}</span>
      <span style={{ color: level === 'ok' ? '#e6e9ef' : LEVEL_COLOR[level], overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

/** One line of the last screen: what was chosen, by name. */
export function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 150px) minmax(0, 1fr)', gap: 10 }}>
      <span style={{ color: theme.dim }}>{label}</span>
      <span style={{ overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

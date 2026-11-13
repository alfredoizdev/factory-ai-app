'use client'

import type { CSSProperties, ReactNode } from 'react'
import { strings } from '@/ui/strings'
import { brand } from '@/ui/brand'
import { theme } from '@/ui/theme'

// Small pieces every screen of the "New project" wizard shares.

export const field: CSSProperties = { padding: '10px 12px', background: brand.bg, color: 'inherit', border: `1px solid ${brand.line}`, borderRadius: 8, fontSize: 14, minWidth: 0 }
export const mono: CSSProperties = { fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }
export const hint: CSSProperties = { fontSize: 13, lineHeight: 1.45, color: brand.quiet, margin: 0 }
export const lead: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 700 }

export const button = (primary: boolean, busy = false): CSSProperties => ({
  padding: '8px 14px',
  borderRadius: 8,
  border: `1px solid ${primary ? brand.green : brand.line}`,
  background: primary ? brand.green : brand.card,
  color: primary ? brand.onGreen : 'inherit',
  fontWeight: 700,
  cursor: busy ? 'wait' : 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
})

/** A tile or card the person picks: outlined in the accent colour when chosen. */
export const choice = (picked: boolean): CSSProperties => ({
  border: `${picked ? 2 : 1}px solid ${picked ? brand.green : brand.line}`,
  background: picked ? brand.greenWash : brand.bg,
  // One pixel less padding when picked, so the thicker outline does not move what is inside.
  margin: picked ? 0 : 1,
  borderRadius: 10,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
})

/** Where the person is: every step numbered and joined by a line; the ones behind are green, the current one filled. */
export function StepBar({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol data-testid="wizard-steps" aria-label={strings.wizard.stepOf(current + 1, steps.length)} style={{ display: 'grid', gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`, margin: 0, padding: 0, listStyle: 'none' }}>
      {steps.map((name, i) => {
        const here = i === current
        const done = i < current
        return (
          <li key={name} aria-current={here ? 'step' : undefined} style={{ display: 'grid', gap: 8, paddingRight: 10, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 26,
                  height: 26,
                  flex: 'none',
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: brand.mono,
                  fontSize: 12,
                  fontWeight: 700,
                  background: here ? brand.green : 'transparent',
                  color: here ? brand.onGreen : done ? brand.green : brand.faint,
                  border: `1px solid ${here || done ? brand.green : brand.line}`,
                }}
              >
                {i + 1}
              </span>
              {i < steps.length - 1 && <span aria-hidden="true" style={{ flex: 1, height: 1, background: done ? brand.green : brand.line }} />}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: here ? 700 : 500, color: here ? brand.text : done ? brand.quiet : brand.faint, overflowWrap: 'anywhere' }}>{name}</span>
          </li>
        )
      })}
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
      <span style={{ color: brand.quiet }}>{label}</span>
      <span style={{ color: level === 'ok' ? brand.text : LEVEL_COLOR[level], overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

/** One line of the last screen: what was chosen, by name. */
export function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 150px) minmax(0, 1fr)', gap: 10 }}>
      <span style={{ color: brand.quiet }}>{label}</span>
      <span style={{ overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

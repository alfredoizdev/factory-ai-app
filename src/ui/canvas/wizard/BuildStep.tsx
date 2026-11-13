'use client'

import { BACK_ENDS, FRONT_ENDS, type Stack, type StackOption } from '@/domain/stack'
import { strings } from '@/ui/strings'
import { brand } from '@/ui/brand'
import { choice, hint, lead } from './parts'
import { STACK_ICONS } from './stackIcons'

const w = strings.wizard.build

/** What the new project is made with: one front end (or none) and any back-end pieces, each a tile with its logo. */
export function BuildStep({ stack, onChange }: { stack: Stack; onChange: (next: Stack) => void }) {
  const tile = (o: StackOption, picked: boolean, onPick: () => void) => {
    const icon = STACK_ICONS[o.id]
    return (
      <button key={o.id} type="button" aria-pressed={picked} onClick={onPick} style={{ ...choice(picked), padding: '12px 6px 10px', display: 'grid', justifyItems: 'center', gap: 7, fontSize: 13 }}>
        <span style={{ width: 34, height: 34, borderRadius: 8, background: '#fff', display: 'grid', placeItems: 'center' }}>
          {icon && (
            <svg viewBox="0 0 24 24" width={22} height={22} fill={`#${icon.hex}`} aria-hidden="true">
              <path d={icon.path} />
            </svg>
          )}
        </span>
        {o.label}
      </button>
    )
  }
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 8 } as const
  const label = { fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: brand.quiet } as const
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <h3 style={lead}>{w.lead}</h3>
      <p style={hint}>{w.hint}</p>
      <div role="group" aria-label={w.frontEnd} style={{ display: 'grid', gap: 8 }}>
        <span style={label}>{w.frontEnd}</span>
        <div style={grid}>{FRONT_ENDS.map(o => tile(o, stack.frontEnd === o.id, () => onChange({ ...stack, frontEnd: stack.frontEnd === o.id ? null : o.id })))}</div>
      </div>
      <div role="group" aria-label={w.backEnd} style={{ display: 'grid', gap: 8 }}>
        <span style={label}>
          {w.backEnd} <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>· {w.backEndHint}</span>
        </span>
        <div style={grid}>
          {BACK_ENDS.map(o => {
            const picked = stack.backEnds.includes(o.id)
            return tile(o, picked, () => onChange({ ...stack, backEnds: picked ? stack.backEnds.filter(b => b !== o.id) : [...stack.backEnds, o.id] }))
          })}
        </div>
      </div>
      <p style={hint}>{w.agentsChoose}</p>
    </div>
  )
}

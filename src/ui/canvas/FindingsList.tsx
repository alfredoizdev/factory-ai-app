'use client'

import { useId, useState } from 'react'
import type { FindingView, How } from '@/engine/finding-view'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

const MONO = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

// What needs the person comes first, then what was dealt with.
const ORDER: readonly FindingView['ending'][] = ['needs_you', 'in_progress', 'fixed', 'set_aside']
const TONE: Record<FindingView['ending'], string> = { needs_you: theme.waiting, in_progress: theme.running, fixed: theme.passed, set_aside: theme.skipped }

// Three marks that differ in shape and in words, never in colour alone: a solid tick, a speech bubble, a dashed ring.
const MARK: Record<How, { colour: string; icon: React.ReactNode }> = {
  checked: {
    colour: theme.passed,
    icon: <path d="M3 8.5 6.5 12 13 4.5" />,
  },
  ai: {
    colour: theme.waiting,
    icon: (
      <>
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        <path d="M5.5 7h.01M8 7h.01M10.5 7h.01" />
      </>
    ),
  },
  not_checked: {
    colour: theme.dim,
    icon: (
      <>
        <circle cx="8" cy="8" r="5.5" strokeDasharray="2.4 2.2" />
        <path d="M5.5 8h5" />
      </>
    ),
  },
}

export function HowMark({ how }: { how: How }) {
  const mark = MARK[how]
  return (
    <span
      data-testid="how-mark"
      data-state={how}
      title={strings.findings.howMeans[how]}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, border: `1px ${how === 'not_checked' ? 'dashed' : 'solid'} ${mark.colour}`, color: mark.colour, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {mark.icon}
      </svg>
      {strings.findings.how[how]}
    </span>
  )
}

function Row({ f }: { f: FindingView }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const d = f.detail
  const fact = (label: string, value: string, mono = false) =>
    value === '' ? null : (
      <div style={{ display: 'grid', gap: 2 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: theme.dim }}>{label}</span>
        <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', fontFamily: mono ? MONO : undefined, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</span>
      </div>
    )
  return (
    <li data-testid="finding" style={{ display: 'grid', gap: 6, padding: '10px 12px', borderRadius: 10, border: `1px solid ${theme.border}`, borderLeft: `3px solid ${TONE[f.ending]}`, background: '#0d1118' }}>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{f.title}</span>
      <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{f.outcome}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <HowMark how={f.how} />
        <button
          type="button"
          className="factory-action"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(v => !v)}
          style={{ background: 'none', border: 'none', padding: 0, color: theme.running, cursor: 'pointer', fontSize: 12.5 }}
        >
          {strings.question.seeDetails}
        </button>
      </span>
      {open && (
        <div id={id} style={{ display: 'grid', gap: 8, paddingTop: 8, borderTop: `1px solid ${theme.lineSoft}` }}>
          {fact(strings.findings.detail.where, d.where, true)}
          {d.problem !== '' && (
            <div style={{ display: 'grid', gap: 2 }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: theme.waiting }}>{strings.findings.detail.aiSaid}</span>
              <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{d.problem}</span>
            </div>
          )}
          {fact(strings.findings.detail.command, d.command, true)}
          {fact(strings.findings.detail.output, d.outputTail, true)}
          {fact(strings.findings.detail.why, d.reason)}
          {d.where === '' && d.problem === '' && d.command === '' && d.outputTail === '' && d.reason === '' && <span style={{ fontSize: 12.5, color: theme.dim }}>{strings.findings.detail.none}</span>}
        </div>
      )}
    </li>
  )
}

/**
 * Every problem the reviewers reported and how each one ended: grouped as needs you, fixed, set aside. One plain line and
 * one mark of how it was checked on the first level; the place, the reviewer's own words, the command and what it printed
 * are one click away.
 */
export function FindingsList({ findings }: { findings: readonly FindingView[] }) {
  return (
    <section data-testid="findings-list" aria-label={strings.findings.heading} style={{ display: 'grid', gap: 10 }}>
      <h3 className="factory-display" style={{ margin: 0, fontSize: 15 }}>{strings.findings.heading}</h3>
      {findings.length === 0 && <p style={{ margin: 0, fontSize: 13, color: theme.dim }}>{strings.findings.none}</p>}
      {ORDER.map(ending => {
        const group = findings.filter(f => f.ending === ending)
        if (group.length === 0) return null
        return (
          <div key={ending} style={{ display: 'grid', gap: 6 }}>
            <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: TONE[ending] }}>
              {strings.findings.group[ending]}
              <span style={{ fontSize: 11, padding: '0 7px', borderRadius: 999, border: `1px solid ${TONE[ending]}` }}>{group.length}</span>
            </h4>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {group.map(f => (
                <Row key={f.id} f={f} />
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

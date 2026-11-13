'use client'

import { useState, type CSSProperties } from 'react'
import { AddProjectDialog } from '@/ui/canvas/AddProjectDialog'
import { Logo } from '@/ui/Logo'
import { strings } from '@/ui/strings'

const w = strings.welcome

// This page's own palette: near-black, one green accent, quiet greys. It is the first thing a person sees, before any
// canvas, so it is plainer and larger than the working screens.
const c = { bg: '#111111', text: '#e8eaf0', quiet: '#a3a3a3', faint: '#8a8a8a', line: '#2a2a2a', card: '#181818', green: '#79dc8b', onGreen: '#0d1f12' }
const mono = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'
const sans = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const label: CSSProperties = { margin: 0, fontFamily: mono, fontSize: 12.5, fontWeight: 500, letterSpacing: '0.2em', textTransform: 'uppercase', color: c.faint }

/**
 * What the app shows before there is any project: what it does, the two ways to start a project (each opening the
 * "New project" wizard on that way), the path every task takes, and what it can do.
 */
export function Welcome() {
  const [adding, setAdding] = useState<'scratch' | 'existing' | null>(null)
  const start = (way: 'scratch' | 'existing') => {
    const primary = way === 'scratch'
    return (
      <button
        type="button"
        data-testid={`welcome-${way}`}
        onClick={() => setAdding(way)}
        style={{
          minHeight: 168,
          padding: '24px 26px 26px',
          borderRadius: 16,
          border: `1px solid ${primary ? c.green : c.line}`,
          background: primary ? c.green : c.card,
          color: primary ? c.onGreen : c.text,
          cursor: 'pointer',
          font: 'inherit',
          textAlign: 'left',
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto auto',
          gap: 6,
        }}
      >
        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ ...label, color: primary ? c.onGreen : c.faint }}>{primary ? w.scratchLabel : w.existingLabel}</span>
          <span aria-hidden="true" style={{ fontSize: 20 }}>→</span>
        </span>
        <span />
        <strong style={{ fontSize: 23, letterSpacing: '-0.02em' }}>{primary ? w.scratch : w.existing}</strong>
        <span style={{ fontSize: 15, lineHeight: 1.45, color: primary ? c.onGreen : c.quiet }}>{primary ? w.scratchHint : w.existingHint}</span>
      </button>
    )
  }
  return (
    <main style={{ minHeight: '100vh', background: c.bg, color: c.text, fontFamily: sans, padding: 'clamp(28px, 6vw, 64px) clamp(16px, 5vw, 56px) 72px' }}>
      <div style={{ width: 'min(1160px, 100%)', margin: '0 auto', display: 'grid', gap: 'clamp(48px, 8vw, 88px)' }}>
        <section style={{ display: 'grid', gap: 'clamp(28px, 4vw, 48px)' }}>
          <div style={{ display: 'grid', gap: 22 }}>
            <p style={{ ...label, color: c.green, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: c.text, display: 'flex' }}><Logo size={30} accent={c.green} /></span>
              {w.eyebrow}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: '24px 56px', alignItems: 'end' }}>
              <h1 style={{ margin: 0, fontSize: 'clamp(40px, 6.6vw, 76px)', lineHeight: 1.02, fontWeight: 700, letterSpacing: '-0.04em', textWrap: 'balance' }}>
                {w.titleLead} <span style={{ color: c.quiet }}>{w.titleRest}</span>
              </h1>
              <p style={{ margin: 0, fontSize: 'clamp(16px, 1.5vw, 19px)', lineHeight: 1.6, color: c.quiet, textWrap: 'pretty', paddingBottom: 6 }}>{w.lead}</p>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 16 }}>
            {start('scratch')}
            {start('existing')}
          </div>
        </section>

        <section aria-label={w.howTitle} style={{ display: 'grid', gap: 28 }}>
          <h2 style={label}>{w.howTitle}</h2>
          <ol data-testid="welcome-steps" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '28px 0' }}>
            {w.steps.map((s, i) => {
              const last = i === w.steps.length - 1
              return (
                <li key={s.name} style={{ display: 'grid', gap: 6, paddingRight: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <span style={{ width: 30, height: 30, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', fontFamily: mono, fontSize: 13, fontWeight: 700, background: last ? c.green : c.card, color: last ? c.onGreen : c.text, border: `1px solid ${last ? c.green : c.line}` }}>
                      {i + 1}
                    </span>
                    {!last && <span aria-hidden="true" style={{ flex: 1, height: 1, background: c.line }} />}
                  </span>
                  <strong style={{ fontSize: 17, letterSpacing: '-0.01em' }}>{s.name}</strong>
                  <span style={{ fontSize: 14.5, color: c.quiet }}>{s.hint}</span>
                </li>
              )
            })}
          </ol>
        </section>

        <section aria-label={w.canTitle} style={{ display: 'grid', gap: 28 }}>
          <h2 style={label}>{w.canTitle}</h2>
          {/* One outlined block; the cells are told apart by hairlines, drawn by the gap over the line colour. */}
          <div data-testid="welcome-can" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 1, background: c.line, border: `1px solid ${c.line}`, borderRadius: 16, overflow: 'hidden' }}>
            {w.can.map((item, i) => (
              <article key={item.title} style={{ padding: '28px 28px 32px', background: c.bg, display: 'grid', gap: 12, alignContent: 'start' }}>
                <span style={{ fontFamily: mono, fontSize: 12.5, color: c.green }}>{String(i + 1).padStart(2, '0')}</span>
                <h3 style={{ margin: '6px 0 0', fontSize: 19, letterSpacing: '-0.015em' }}>{item.title}</h3>
                <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: c.quiet }}>{item.text}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
      {adding && <AddProjectDialog startWith={adding} onClose={() => setAdding(null)} onCreated={id => window.location.assign(`/canvas/${id}`)} />}
    </main>
  )
}

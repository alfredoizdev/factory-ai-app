'use client'

import { useState, type CSSProperties } from 'react'
import { AddProjectDialog } from '@/ui/canvas/AddProjectDialog'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

const w = strings.welcome

const label: CSSProperties = { margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: theme.dim }

/**
 * What the app shows before there is any project: what it does, the path every task takes, what it can do, and the
 * two ways to start a project, each opening the "New project" wizard on that way.
 */
export function Welcome() {
  const [adding, setAdding] = useState<'scratch' | 'existing' | null>(null)
  const start = (way: 'scratch' | 'existing', primary: boolean) => (
    <button
      type="button"
      data-testid={`welcome-${way}`}
      onClick={() => setAdding(way)}
      style={{
        flex: '1 1 240px',
        padding: '16px 18px',
        borderRadius: 12,
        border: `1px solid ${primary ? theme.running : theme.border}`,
        background: primary ? theme.running : theme.card,
        color: primary ? '#fff' : '#e6e9ef',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
        display: 'grid',
        gap: 4,
      }}
    >
      <strong style={{ fontSize: 16.5 }}>{way === 'scratch' ? w.scratch : w.existing} →</strong>
      <span style={{ fontSize: 13.5, lineHeight: 1.45, color: primary ? 'rgba(255,255,255,0.86)' : theme.dim }}>{way === 'scratch' ? w.scratchHint : w.existingHint}</span>
    </button>
  )
  return (
    <main style={{ minHeight: '100vh', background: `radial-gradient(900px 480px at 50% -10%, rgba(59, 130, 246, 0.16), transparent 70%), ${theme.bg}`, color: '#e6e9ef', padding: '56px 16px 64px' }}>
      <div style={{ width: 'min(980px, 100%)', margin: '0 auto', display: 'grid', gap: 44 }}>
        <section style={{ display: 'grid', gap: 16, justifyItems: 'center', textAlign: 'center' }}>
          <p style={{ ...label, color: '#9cc2ff' }}>{w.eyebrow}</p>
          <h1 className="factory-display" style={{ margin: 0, fontSize: 'clamp(28px, 4.6vw, 44px)', lineHeight: 1.12, maxWidth: 780, textWrap: 'balance' }}>
            {w.title}
          </h1>
          <p style={{ margin: 0, fontSize: 16.5, lineHeight: 1.6, color: theme.dim, maxWidth: 660, textWrap: 'pretty' }}>{w.lead}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, width: 'min(620px, 100%)', marginTop: 8 }}>
            {start('scratch', true)}
            {start('existing', false)}
          </div>
        </section>

        <section aria-label={w.howTitle} style={{ display: 'grid', gap: 14 }}>
          <h2 style={label}>{w.howTitle}</h2>
          <ol data-testid="welcome-steps" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            {w.steps.map((s, i) => (
              <li key={s.name} style={{ padding: '14px 14px 13px', borderRadius: 12, background: theme.cardFace, border: `1px solid ${theme.border}`, display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: i === w.steps.length - 1 ? theme.passed : '#9cc2ff' }}>{i + 1}</span>
                <strong style={{ fontSize: 15 }}>{s.name}</strong>
                <span style={{ fontSize: 13, color: theme.dim }}>{s.hint}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-label={w.canTitle} style={{ display: 'grid', gap: 14 }}>
          <h2 style={label}>{w.canTitle}</h2>
          <div data-testid="welcome-can" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 12 }}>
            {w.can.map(c => (
              <article key={c.title} style={{ padding: 18, borderRadius: 12, background: theme.card, border: `1px solid ${theme.border}`, display: 'grid', gap: 7, alignContent: 'start' }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>{c.title}</h3>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: theme.dim }}>{c.text}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
      {adding && <AddProjectDialog startWith={adding} onClose={() => setAdding(null)} onCreated={id => window.location.assign(`/canvas/${id}`)} />}
    </main>
  )
}

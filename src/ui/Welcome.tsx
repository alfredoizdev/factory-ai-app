'use client'

import { useState } from 'react'
import { AddProjectDialog } from '@/ui/canvas/AddProjectDialog'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

const w = strings.welcome

/** What the app shows before there is any project: what it is, in two lines, and the one button that starts one. */
export function Welcome() {
  const [adding, setAdding] = useState(false)
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16, background: theme.bg, color: '#e6e9ef' }}>
      <div style={{ width: 'min(520px, 100%)', display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center' }}>
        <h1 className="factory-display" style={{ margin: 0, fontSize: 30 }}>{w.title}</h1>
        <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.55, color: theme.dim }}>{w.lead}</p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{ marginTop: 6, padding: '11px 20px', borderRadius: 10, border: `1px solid ${theme.running}`, background: theme.running, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}
        >
          ＋ {strings.projectSwitcher.add}
        </button>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: theme.dim }}>{w.hint}</p>
      </div>
      {adding && <AddProjectDialog onClose={() => setAdding(false)} onCreated={id => window.location.assign(`/canvas/${id}`)} />}
    </main>
  )
}

'use client'

import { useEffect, useState } from 'react'
import type { ProjectNote } from '@/engine/memory'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

/**
 * The project's memory, in its settings: the rules every task starts with. Learned from what the person said on
 * earlier tasks, or written here. Each can be reworded, switched off or deleted; a new one can be added.
 */
export function ProjectMemory({ projectId }: { projectId: string }) {
  const [notes, setNotes] = useState<ProjectNote[] | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const base = `/api/projects/${projectId}/notes`

  useEffect(() => {
    let live = true
    fetch(base)
      .then(r => (r.ok ? (r.json() as Promise<{ notes: ProjectNote[] }>) : null))
      .then(d => live && setNotes(d?.notes ?? []))
      .catch(() => live && setNotes([]))
    return () => {
      live = false
    }
  }, [base])

  async function call(url: string, method: string, body?: unknown): Promise<{ note?: ProjectNote } | null> {
    setError(null)
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null)
    if (!res) return setError(strings.memory.failed), null
    if (res.status === 204) return {}
    const answer = (await res.json().catch(() => null)) as { note?: ProjectNote; error?: string } | null
    if (!res.ok) return setError(answer?.error ?? strings.memory.failed), null
    return answer
  }

  async function add() {
    const answer = await call(base, 'POST', { text: draft })
    if (answer?.note) {
      setNotes(ns => [...(ns ?? []), answer.note!])
      setDraft('')
    }
  }
  async function change(id: string, patch: { text?: string; enabled?: boolean }) {
    const answer = await call(`${base}/${id}`, 'PATCH', patch)
    if (answer?.note) setNotes(ns => (ns ?? []).map(n => (n.id === id ? answer.note! : n)))
    setEditing(null)
  }
  async function remove(id: string) {
    if (await call(`${base}/${id}`, 'DELETE')) setNotes(ns => (ns ?? []).filter(n => n.id !== id))
  }

  const field = { font: 'inherit', fontSize: 13, padding: '7px 9px', background: '#0b0e14', color: '#e6e9ef', border: `1px solid ${theme.border}`, borderRadius: 8 } as const
  return (
    <section data-testid="project-memory" style={{ display: 'grid', gap: 8, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
      <h3 className="factory-display" style={{ margin: 0, fontSize: 15 }}>
        {strings.memory.title}
      </h3>
      <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>{strings.memory.what}</span>
      {notes !== null && notes.length === 0 && <span style={{ fontSize: 12.5, color: theme.skipped }}>{strings.memory.none}</span>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {(notes ?? []).map(n => (
          <li key={n.id} style={{ display: 'grid', gap: 4, padding: '8px 10px', borderRadius: 8, border: `1px solid ${theme.border}`, borderLeft: `3px solid ${n.enabled ? '#2dd4bf' : theme.skipped}`, background: '#0d1118', opacity: n.enabled ? 1 : 0.6 }}>
            {editing?.id === n.id ? (
              <input
                aria-label={strings.memory.edit}
                autoFocus
                value={editing.text}
                onChange={e => setEditing({ id: n.id, text: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter') void change(n.id, { text: editing.text })
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEditing(null)
                  }
                }}
                onBlur={() => void change(n.id, { text: editing.text })}
                style={field}
              />
            ) : (
              <span style={{ fontSize: 13, lineHeight: 1.45, color: '#e6e9ef' }}>{n.text}</span>
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: theme.dim }}>
              <span style={{ flex: 1 }}>{strings.memory.source[n.source]}</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={n.enabled} onChange={e => void change(n.id, { enabled: e.target.checked })} />
                {strings.memory.on}
              </label>
              <button type="button" onClick={() => setEditing({ id: n.id, text: n.text })} style={{ background: 'none', border: 'none', padding: 0, color: '#93c5fd', cursor: 'pointer', fontSize: 11.5 }}>
                {strings.memory.edit}
              </button>
              <button type="button" aria-label={strings.memory.remove(n.text)} onClick={() => void remove(n.id)} style={{ background: 'none', border: 'none', padding: 0, color: theme.failed, cursor: 'pointer', fontSize: 11.5 }}>
                {strings.memory.delete}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          aria-label={strings.memory.addLabel}
          value={draft}
          maxLength={240}
          placeholder={strings.memory.placeholder}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && draft.trim()) void add()
          }}
          style={{ ...field, flex: 1, minWidth: 0 }}
        />
        <button type="button" disabled={!draft.trim()} onClick={() => void add()} style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${theme.border}`, background: draft.trim() ? theme.running : 'transparent', color: draft.trim() ? '#fff' : theme.skipped, fontWeight: 700, cursor: draft.trim() ? 'pointer' : 'not-allowed' }}>
          {strings.memory.add}
        </button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 12, color: theme.failed }}>
          {error}
        </div>
      )}
    </section>
  )
}

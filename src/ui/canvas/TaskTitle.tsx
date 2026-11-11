'use client'

import { useEffect, useRef, useState } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

/**
 * The open task's name, large, at the top left of the canvas. The pencil renames it in place: Enter saves, Escape
 * keeps the old name. A name suggested in the background shows up on its own a few seconds after the task starts.
 */
export function TaskTitle({ runId, initial, onRenamed }: { runId: string; initial: string; onRenamed?: (title: string) => void }) {
  const [title, setTitle] = useState(initial)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // A suggested name arrives a moment after a task starts: look again twice, unless the person is renaming it.
  useEffect(() => {
    const timers = [4000, 12000].map(ms =>
      setTimeout(() => {
        void fetch(`/api/runs/${runId}`)
          .then(r => (r.ok ? (r.json() as Promise<{ title?: string }>) : null))
          .then(d => d?.title && setTitle(t => (t === d.title ? t : d.title!)))
          .catch(() => undefined)
      }, ms),
    )
    return () => timers.forEach(clearTimeout)
  }, [runId])

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  async function save() {
    const next = draft.trim()
    if (next === '' || next === title) return setEditing(false)
    const res = await fetch(`/api/runs/${runId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: next }) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { title?: string; error?: string } | null
    if (!res?.ok || !body?.title) return setError(body?.error ?? strings.title.empty)
    setTitle(body.title)
    setEditing(false)
    setError(null)
    onRenamed?.(body.title)
  }

  return (
    <div data-testid="task-title" style={{ position: 'absolute', top: 14, left: 52, zIndex: 4, maxWidth: 'min(720px, calc(100% - 560px))', display: 'grid', gap: 4 }}>
      {editing ? (
        <input
          ref={input}
          aria-label={strings.title.rename}
          value={draft}
          maxLength={60}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={e => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setDraft(title)
              setEditing(false)
            }
          }}
          style={{ font: 'inherit', fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em', color: '#e6e9ef', background: '#0b0e14', border: `1px solid ${theme.running}`, borderRadius: 8, padding: '2px 8px', minWidth: 320 }}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em', color: '#e6e9ef', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={title}>
            {title}
          </h1>
          <button
            type="button"
            aria-label={strings.title.rename}
            title={strings.title.rename}
            onClick={() => {
              setDraft(title)
              setEditing(true)
            }}
            style={{ flex: 'none', width: 28, height: 28, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.card, color: theme.dim, cursor: 'pointer' }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11 2.5 13.5 5 6 12.5 3 13l.5-3L11 2.5Z" />
            </svg>
          </button>
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12, color: theme.failed }}>
          {error}
        </div>
      )}
    </div>
  )
}

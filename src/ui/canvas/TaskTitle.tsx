'use client'

import { useEffect, useRef, useState } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

/**
 * The open task's name, large, at the top left of the canvas. Without one, a quiet invitation to add it. Clicking it
 * (or the pencil) edits it in place: Enter saves, Escape keeps what was there.
 */
export function TaskTitle({ runId, initial, onRenamed }: { runId: string; initial: string; onRenamed?: (title: string) => void }) {
  const [title, setTitle] = useState(initial)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  async function save() {
    const next = draft.trim()
    if (next === '' || next === title) {
      setError(null)
      return setEditing(false)
    }
    const res = await fetch(`/api/runs/${runId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: next }) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { title?: string; error?: string } | null
    if (!res?.ok || !body?.title) return setError(body?.error ?? strings.title.empty)
    setTitle(body.title)
    setEditing(false)
    setError(null)
    onRenamed?.(body.title)
  }

  return (
    <div data-testid="task-title" style={{ position: 'absolute', top: 18, left: 24, zIndex: 4, maxWidth: 'min(760px, calc(100% - 560px))', display: 'grid', gap: 4 }}>
      {editing ? (
        <input
          ref={input}
          aria-label={strings.title.rename}
          value={draft}
          maxLength={60}
          placeholder={strings.title.add}
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
          style={{ font: 'inherit', fontSize: 32, fontWeight: 800, letterSpacing: '-0.015em', color: '#e6e9ef', background: '#0b0e14', border: `1px solid ${theme.running}`, borderRadius: 8, padding: '2px 8px', minWidth: 320 }}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <h1
            onClick={() => {
              setDraft(title)
              setEditing(true)
            }}
            style={{ margin: 0, fontSize: 32, fontWeight: title ? 800 : 600, letterSpacing: '-0.015em', color: title ? '#e6e9ef' : theme.skipped, fontStyle: title ? 'normal' : 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}
            title={title || strings.title.add}
          >
            {title || strings.title.add}
          </h1>
          <button
            type="button"
            aria-label={strings.title.rename}
            title={strings.title.rename}
            onClick={() => {
              setDraft(title)
              setEditing(true)
            }}
            style={{ flex: 'none', width: 32, height: 32, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.card, color: theme.dim, cursor: 'pointer' }}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

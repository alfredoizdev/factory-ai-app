'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { label as entryLabel, type Entry } from '@/engine/register'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

type Candidate = { area: string; paths: string[] }
type Answer = { note?: Partial<Entry> & { id: string }; error?: string }

/** The kinds a person can reword, switch off and remove. The log of what reviewers found is theirs to read only. */
const EDITABLE = ['rule', 'decision', 'core'] as const
type Editable = (typeof EDITABLE)[number]
const isEditable = (e: Entry): e is Entry & { kind: Editable } => (EDITABLE as readonly string[]).includes(e.kind)

const TONE: Record<Editable, string> = { rule: '#2dd4bf', decision: '#a78bfa', core: theme.waiting }
// Text buttons keep a tap target of at least 32px tall.
const small = { background: 'none', border: 'none', padding: '8px 4px', minHeight: 32, cursor: 'pointer', fontSize: 11.5 } as const

/**
 * The project's register, in its settings: the rules every task starts with, the decisions made when the person answered a
 * question, and the areas marked as core, each with its number and in plain words. The person can reword, switch off or
 * remove their own, mark a new core area, and confirm the areas the app suggests. What reviewers found is a log, folded.
 */
export function ProjectMemory({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [draft, setDraft] = useState('')
  const [corePath, setCorePath] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = `/api/projects/${projectId}/notes`
  const logId = useId()
  const coreId = useId()

  useEffect(() => {
    let live = true
    fetch(base)
      .then(r => (r.ok ? (r.json() as Promise<{ entries?: Entry[]; candidates?: Candidate[] }>) : null))
      .then(d => {
        if (!live) return
        setEntries(d?.entries ?? [])
        setCandidates(d?.candidates ?? [])
      })
      .catch(() => live && setEntries([]))
    return () => {
      live = false
    }
  }, [base])

  const lastError = useRef<string | null>(null)
  const fail = (message: string) => {
    lastError.current = message
    setError(message)
  }
  async function call(url: string, method: string, body?: unknown): Promise<Answer | null> {
    setError(null)
    lastError.current = null
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null)
    if (!res) return fail(strings.memory.failed), null
    if (res.status === 204) return {}
    const answer = (await res.json().catch(() => null)) as Answer | null
    if (!res.ok) return fail(answer?.error ?? strings.memory.failed), null
    return answer
  }
  const added = (note: Answer['note']) => note && setEntries(es => [...(es ?? []), { outcome: null, reason: null, runId: null, enabled: true, paths: [], ...note } as Entry])

  async function addRule() {
    const answer = await call(base, 'POST', { text: draft })
    if (answer?.note) {
      added(answer.note)
      setDraft('')
    }
  }
  async function addCore() {
    const answer = await call(base, 'POST', { kind: 'core', path: corePath })
    if (answer?.note) {
      added(answer.note)
      setCorePath('')
    }
  }
  async function confirmCandidate(c: Candidate) {
    const answer = await call(base, 'POST', { kind: 'core', paths: c.paths, area: c.area })
    if (answer?.note) {
      added(answer.note)
      setCandidates(cs => cs.filter(x => x !== c))
    }
  }
  /** True when the server took the change. A refused edit is left open, with what the person typed. */
  async function change(id: string, patch: { text?: string; enabled?: boolean; path?: string }): Promise<boolean> {
    const answer = await call(`${base}/${id}`, 'PATCH', patch)
    if (!answer?.note) return false
    setEntries(es => (es ?? []).map(e => (e.id === id ? { ...e, ...answer.note } : e)))
    return true
  }
  async function save(e: Entry, text: string) {
    setEditError(null)
    if (await change(e.id, e.kind === 'core' ? { path: text } : { text })) setEditing(null)
    else {
      setEditError(lastError.current)
      setError(null)
    }
  }
  async function remove(id: string) {
    setRemoving(null)
    if (await call(`${base}/${id}`, 'DELETE')) setEntries(es => (es ?? []).filter(e => e.id !== id))
  }

  const field = { font: 'inherit', fontSize: 13, padding: '7px 9px', background: '#0b0e14', color: '#e6e9ef', border: `1px solid ${theme.border}`, borderRadius: 8, boxSizing: 'border-box' } as const
  const primary = (on: boolean) => ({ flex: 'none', padding: '6px 12px', borderRadius: 8, border: `1px solid ${theme.border}`, background: on ? theme.running : 'transparent', color: on ? '#fff' : theme.skipped, fontWeight: 700, cursor: on ? 'pointer' : 'not-allowed' }) as const
  const all = entries ?? []
  const log = all.filter(e => e.kind === 'finding')
  const sentence = (e: Entry) => (e.kind === 'core' && e.text === strings.memory.core.entryText(e.paths.join(', ')) ? null : e.text)

  function row(e: Entry & { kind: Editable }) {
    const isCore = e.kind === 'core'
    const shown = sentence(e)
    const asking = removing === e.id
    return (
      <li key={e.id} style={{ display: 'grid', gap: 4, padding: '8px 10px', borderRadius: 8, border: `1px solid ${theme.border}`, borderLeft: `3px solid ${e.enabled ? TONE[e.kind] : theme.skipped}`, background: '#0d1118', opacity: e.enabled ? 1 : 0.6 }}>
        {editing?.id === e.id ? (
          <>
            <input
              aria-label={strings.memory.edit}
              autoFocus
              value={editing.text}
              onChange={ev => setEditing({ id: e.id, text: ev.target.value })}
              onKeyDown={ev => {
                if (ev.key === 'Enter') void save(e, editing.text)
                if (ev.key === 'Escape') {
                  ev.stopPropagation()
                  setEditing(null)
                  setEditError(null)
                }
              }}
              style={field}
            />
            {editError && (
              <div role="alert" style={{ fontSize: 12, color: theme.failed, lineHeight: 1.4 }}>
                {editError}
              </div>
            )}
            <span style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="factory-action" onClick={() => void save(e, editing.text)} style={{ ...small, fontSize: 12, fontWeight: 700, color: '#93c5fd' }}>
                {strings.memory.saveEdit}
              </button>
              <button
                type="button"
                className="factory-action"
                onClick={() => {
                  setEditing(null)
                  setEditError(null)
                }}
                style={{ ...small, fontSize: 12, color: theme.dim }}
              >
                {strings.memory.cancelEdit}
              </button>
            </span>
          </>
        ) : (
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span title={strings.memory.number(entryLabel(e.number))} style={{ flex: 'none', fontFamily: 'var(--font-mono), ui-monospace, Menlo, monospace', fontSize: 11, color: theme.dim }}>{entryLabel(e.number)}</span>
            <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              {isCore && <span style={{ fontFamily: 'var(--font-mono), ui-monospace, Menlo, monospace', fontSize: 12.5, color: '#e6e9ef', overflowWrap: 'anywhere' }}>{e.paths.join(', ')}</span>}
              {shown !== null && <span style={{ fontSize: 13, lineHeight: 1.45, color: '#e6e9ef', overflowWrap: 'anywhere' }}>{shown}</span>}
            </span>
          </span>
        )}
        {asking ? (
          <span role="group" aria-label={strings.memory.removeAsk(e.text)} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 12, color: '#ffd9d9' }}>
            <span style={{ flex: '1 1 160px', overflowWrap: 'anywhere' }}>{strings.memory.removeAsk(e.text)}</span>
            <button type="button" className="factory-action" autoFocus onClick={() => void remove(e.id)} style={{ ...small, fontSize: 12, color: theme.failed, fontWeight: 700 }}>{strings.memory.removeYes}</button>
            <button type="button" className="factory-action" onClick={() => setRemoving(null)} style={{ ...small, fontSize: 12, color: '#93c5fd' }}>{strings.memory.removeNo}</button>
          </span>
        ) : (
          <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', fontSize: 11.5, color: theme.dim }}>
            <span style={{ flex: 1, minWidth: 80 }}>{!isCore ? ((strings.memory.source as Record<string, string>)[e.source] ?? '') : ''}</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={e.enabled} onChange={ev => void change(e.id, { enabled: ev.target.checked })} />
              {strings.memory.on}
            </label>
            <button type="button" className="factory-action" onClick={() => {
                setEditError(null)
                setEditing({ id: e.id, text: isCore ? e.paths.join(', ') : e.text })
              }} style={{ ...small, color: '#93c5fd' }}>
              {strings.memory.edit}
            </button>
            <button type="button" className="factory-action" aria-label={strings.memory.remove(e.text)} onClick={() => setRemoving(e.id)} style={{ ...small, color: theme.failed }}>
              {strings.memory.delete}
            </button>
          </span>
        )}
      </li>
    )
  }

  const group = (kind: Editable, extra?: React.ReactNode) => {
    const rows = all.filter((e): e is Entry & { kind: Editable } => e.kind === kind && isEditable(e))
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#d6dce6' }}>{strings.memory.groups[kind]}</h4>
        {kind === 'core' && <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>{strings.memory.coreWhat}</span>}
        {entries !== null && rows.length === 0 && kind === 'rule' && <span style={{ fontSize: 12.5, color: theme.skipped }}>{strings.memory.none}</span>}
        {entries !== null && rows.length === 0 && kind !== 'rule' && <span style={{ fontSize: 12.5, color: theme.skipped }}>{strings.memory.groupNone[kind]}</span>}
        {rows.length > 0 && <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>{rows.map(row)}</ul>}
        {extra}
      </div>
    )
  }

  return (
    <section data-testid="project-memory" style={{ display: 'grid', gap: 14, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <h3 className="factory-display" style={{ margin: 0, fontSize: 15 }}>
          {strings.memory.title}
        </h3>
        <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>{strings.memory.what}</span>
      </div>

      {group(
        'rule',
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            aria-label={strings.memory.addLabel}
            value={draft}
            maxLength={240}
            placeholder={strings.memory.placeholder}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && draft.trim()) void addRule()
            }}
            style={{ ...field, flex: 1, minWidth: 0 }}
          />
          <button type="button" className="factory-action" disabled={!draft.trim()} onClick={() => void addRule()} style={primary(!!draft.trim())}>
            {strings.memory.add}
          </button>
        </div>,
      )}

      {group('decision')}

      {group(
        'core',
        <>
          {candidates.length > 0 && (
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: theme.waiting }}>{strings.memory.suggestionsTitle}</span>
              {candidates.map(c => (
                <div key={c.area} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: `1px dashed ${theme.tint('waiting', 0.5)}`, background: theme.tint('waiting', 0.05) }}>
                  <span style={{ flex: '1 1 180px', fontSize: 12.5, lineHeight: 1.45, color: '#e6e9ef' }}>{strings.memory.suggestionWhy(c.area)}</span>
                  <button type="button" className="factory-action" onClick={() => void confirmCandidate(c)} style={primary(true)}>
                    {strings.memory.suggestionYes}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gap: 4 }}>
            <label htmlFor={coreId} style={{ fontSize: 12, fontWeight: 600, color: theme.dim }}>
              {strings.memory.coreLabel}
            </label>
            <span style={{ display: 'flex', gap: 6 }}>
              <input
                id={coreId}
                value={corePath}
                placeholder={strings.memory.corePlaceholder}
                onChange={e => setCorePath(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && corePath.trim()) void addCore()
                }}
                style={{ ...field, flex: 1, minWidth: 0, fontWeight: 400 }}
              />
              <button type="button" className="factory-action" disabled={!corePath.trim()} onClick={() => void addCore()} style={primary(!!corePath.trim())}>
                {strings.memory.coreAdd}
              </button>
            </span>
            <span style={{ fontSize: 11.5, color: theme.dim }}>{strings.memory.coreHint}</span>
          </div>
        </>,
      )}

      {log.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#d6dce6' }}>{strings.memory.groups.finding}</h4>
          <button type="button" className="factory-action" aria-expanded={showLog} aria-controls={logId} onClick={() => setShowLog(v => !v)} style={{ ...small, justifySelf: 'start', fontSize: 12.5, color: '#93c5fd' }}>
            {showLog ? strings.memory.hideLog : strings.memory.showLog(log.length)}
          </button>
          {showLog && (
            <div id={logId} style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: theme.waiting }}>{strings.memory.logAi}</span>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
                {log.map(e => (
                  <li key={e.id} style={{ display: 'grid', gap: 2, padding: '6px 10px', borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0d1118', fontSize: 12.5, color: '#c9d1dc' }}>
                    <span style={{ overflowWrap: 'anywhere' }}>
                      <span style={{ fontFamily: 'var(--font-mono), ui-monospace, Menlo, monospace', fontSize: 11, color: theme.dim, marginRight: 8 }}>{entryLabel(e.number)}</span>
                      {e.text}
                    </span>
                    {e.outcome && <span style={{ fontSize: 11.5, color: theme.dim }}>{strings.memory.logEnded[e.outcome]}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && (
        <div role="alert" style={{ fontSize: 12, color: theme.failed }}>
          {error}
        </div>
      )}
    </section>
  )
}

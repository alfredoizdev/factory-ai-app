'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ProjectSummary } from '@/engine/projects'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { AddProjectDialog } from './AddProjectDialog'
import { WorkingSpinner } from './BlockCard'

const s = strings.projectSwitcher

/** Base status as a small mark: being prepared, ready, failed, or not prepared yet. */
function BaseMark({ status }: { status: string }) {
  if (status === 'installing') return <WorkingSpinner blockId="base" size={12} />
  const colour = status === 'ready' ? theme.passed : status === 'failed' ? theme.failed : theme.skipped
  return <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: colour, flexShrink: 0 }} />
}

/**
 * The project the canvas is on, and every other one: switch, add a project, see whether this one's dependencies are
 * prepared (and prepare them again), rename it.
 */
export function ProjectSwitcher({ workflowId, style }: { workflowId: string; style: CSSProperties }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    void fetch('/api/projects')
      .then(r => (r.ok ? (r.json() as Promise<{ projects: ProjectSummary[] }>) : null))
      .then(d => d && setProjects(d.projects))
      .catch(() => undefined)
  }, [])
  useEffect(load, [load])

  const current = projects?.find(p => p.workflowId === workflowId) ?? null
  // While the base is being prepared, ask again now and then until it settles.
  const preparing = current?.baseStatus === 'installing'
  useEffect(() => {
    if (!preparing) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [preparing, load])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  async function prepare() {
    if (!current) return
    await fetch(`/api/projects/${current.projectId}/base`, { method: 'POST' }).catch(() => undefined)
    load()
  }

  async function rename(name: string) {
    if (!current) return
    await fetch(`/api/projects/${current.projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => undefined)
    setRenaming(null)
    load()
  }

  const item: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 10px', background: 'none', border: 'none', borderRadius: 6, color: 'inherit', cursor: 'pointer', fontSize: 13 }
  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ ...style, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, maxWidth: 260 }}>
        {current && <BaseMark status={current.baseStatus} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current?.name ?? s.loading}</span>
        <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
      </button>
      {open && projects && (
        <div role="menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, width: 320, display: 'grid', gap: 2, padding: 6, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 10, boxShadow: '0 18px 40px rgba(0,0,0,0.5)' }}>
          {current && (
            <div style={{ display: 'grid', gap: 6, padding: '6px 10px 10px', borderBottom: `1px solid ${theme.border}`, marginBottom: 4, fontSize: 12 }}>
              {renaming !== null ? (
                <form onSubmit={e => (e.preventDefault(), void rename(renaming))} style={{ display: 'flex', gap: 6 }}>
                  <input autoFocus aria-label={s.rename} value={renaming} onChange={e => setRenaming(e.target.value)} style={{ flex: 1, padding: '5px 7px', background: theme.bg, color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 6 }} />
                  <button type="submit" style={{ ...item, width: 'auto', border: `1px solid ${theme.border}` }}>
                    {s.save}
                  </button>
                </form>
              ) : (
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 13 }}>{current.name}</strong>
                  <button type="button" onClick={() => setRenaming(current.name)} style={{ background: 'none', border: 'none', color: theme.dim, cursor: 'pointer', fontSize: 12 }}>
                    {s.rename}
                  </button>
                </span>
              )}
              <span style={{ color: theme.dim, overflowWrap: 'anywhere', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>{current.repoPath ?? s.noFolder}</span>
              <span data-testid="base-status" style={{ display: 'flex', alignItems: 'center', gap: 6, color: current.baseStatus === 'failed' ? theme.failed : theme.dim }}>
                <BaseMark status={current.baseStatus} /> {s.base[current.baseStatus as keyof typeof s.base] ?? s.base.none}
              </span>
              {current.baseStatus === 'failed' && current.baseMessage && <span style={{ color: theme.dim, overflowWrap: 'anywhere' }}>{current.baseMessage}</span>}
              {current.repoPath && current.baseStatus !== 'installing' && (
                <button type="button" onClick={() => void prepare()} style={{ ...item, width: 'auto', justifySelf: 'start', border: `1px solid ${theme.border}`, padding: '4px 10px', fontSize: 12 }}>
                  {current.baseStatus === 'ready' ? s.prepareAgain : s.prepare}
                </button>
              )}
            </div>
          )}
          {projects.map(p => (
            <a key={p.projectId} role="menuitem" href={`/canvas/${p.workflowId}`} aria-current={p.workflowId === workflowId ? 'true' : undefined} style={{ ...item, textDecoration: 'none', background: p.workflowId === workflowId ? theme.tint('running', 0.12) : 'none' }}>
              <BaseMark status={p.baseStatus} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </a>
          ))}
          <button type="button" role="menuitem" onClick={() => (setOpen(false), setAdding(true))} style={{ ...item, color: '#93c5fd', fontWeight: 600, marginTop: 4, borderTop: `1px solid ${theme.border}`, borderRadius: 0, paddingTop: 10 }}>
            ＋ {s.add}
          </button>
        </div>
      )}
      {adding && <AddProjectDialog onClose={() => setAdding(false)} onCreated={id => window.location.assign(`/canvas/${id}`)} />}
    </div>
  )
}

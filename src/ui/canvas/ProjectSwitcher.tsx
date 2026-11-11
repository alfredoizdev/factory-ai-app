'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ProjectSummary } from '@/engine/projects'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { AddProjectDialog } from './AddProjectDialog'
import { SettingsIcon } from './SettingsIcon'
import { WorkingSpinner } from './BlockCard'

const s = strings.projectSwitcher

const sectionTitle: CSSProperties = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: theme.dim }

/** A real, bordered button: primary (blue) for the thing to do next, quiet otherwise. */
function smallButton(primary: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    borderRadius: 6,
    border: `1px solid ${primary ? theme.running : theme.border}`,
    background: primary ? theme.running : theme.bg,
    color: primary ? '#fff' : '#d6dce6',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}

function baseTone(status: string): { border: string; background: string } {
  if (status === 'ready') return { border: theme.tint('passed', 0.4), background: theme.tint('passed', 0.07) }
  if (status === 'failed') return { border: theme.tint('failed', 0.45), background: theme.tint('failed', 0.07) }
  if (status === 'installing') return { border: theme.tint('running', 0.45), background: theme.tint('running', 0.07) }
  return { border: theme.tint('waiting', 0.4), background: theme.tint('waiting', 0.06) }
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 2.5 13.5 5 6 12.5 3 13l.5-3L11 2.5Z" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  )
}

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
export function ProjectSwitcher({ workflowId, style, onOpenSettings }: { workflowId: string; style: CSSProperties; onOpenSettings?: () => void }) {
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
    // Capture phase: the canvas stops pointer events from bubbling (it pans and zooms on them), so a click there would
    // never reach a listener waiting at the bottom. Escape closes it too.
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
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
        <div role="menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, width: 340, display: 'grid', gap: 2, padding: 8, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 10, boxShadow: '0 18px 40px rgba(0,0,0,0.5)' }}>
          {current && (
            <section aria-label={s.thisProject} style={{ display: 'grid', gap: 10, padding: '8px 8px 12px', borderBottom: `1px solid ${theme.border}`, marginBottom: 6 }}>
              <span style={sectionTitle}>{s.thisProject}</span>
              {renaming !== null ? (
                <form onSubmit={e => (e.preventDefault(), void rename(renaming))} style={{ display: 'flex', gap: 6 }}>
                  <input
                    autoFocus
                    aria-label={s.rename}
                    value={renaming}
                    onChange={e => setRenaming(e.target.value)}
                    onKeyDown={e => e.key === 'Escape' && (e.stopPropagation(), setRenaming(null))}
                    style={{ flex: 1, minWidth: 0, padding: '6px 8px', background: theme.bg, color: 'inherit', border: `1px solid ${theme.running}`, borderRadius: 6, fontSize: 13 }}
                  />
                  <button type="submit" style={smallButton(true)}>
                    {s.save}
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} style={smallButton(false)}>
                    {s.cancel}
                  </button>
                </form>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.name}</strong>
                  <button type="button" onClick={() => setRenaming(current.name)} style={smallButton(false)}>
                    <PencilIcon /> {s.rename}
                  </button>
                  {onOpenSettings && (
                    <button type="button" onClick={() => (setOpen(false), onOpenSettings())} style={smallButton(false)}>
                      <SettingsIcon size={12} /> {s.settings}
                    </button>
                  )}
                </div>
              )}
              <span style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: theme.dim, fontSize: 11.5 }}>
                <FolderIcon />
                <span style={{ overflowWrap: 'anywhere', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{current.repoPath ?? s.noFolder}</span>
              </span>
              {/* The dependencies' state, coloured by what it means, with what to do about it right there. */}
              <div
                data-testid="base-status"
                style={{
                  display: 'grid',
                  gap: 8,
                  padding: 10,
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.4,
                  border: `1px solid ${baseTone(current.baseStatus).border}`,
                  background: baseTone(current.baseStatus).background,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <BaseMark status={current.baseStatus} />
                  <span>{s.base[current.baseStatus as keyof typeof s.base] ?? s.base.none}</span>
                </span>
                {current.baseStatus === 'failed' && current.baseMessage && <span style={{ color: theme.dim, overflowWrap: 'anywhere' }}>{current.baseMessage}</span>}
                {current.repoPath && current.baseStatus !== 'installing' && (
                  <button type="button" onClick={() => void prepare()} style={{ ...smallButton(current.baseStatus !== 'ready'), justifySelf: 'start' }}>
                    {current.baseStatus === 'ready' ? s.prepareAgain : s.prepare}
                  </button>
                )}
              </div>
            </section>
          )}
          <span style={{ ...sectionTitle, padding: '2px 8px 4px' }}>{s.switchTo}</span>
          {projects.map(p => (
            <a key={p.projectId} role="menuitem" href={`/canvas/${p.workflowId}`} aria-current={p.workflowId === workflowId ? 'true' : undefined} style={{ ...item, textDecoration: 'none', background: p.workflowId === workflowId ? theme.tint('running', 0.12) : 'none' }}>
              <BaseMark status={p.baseStatus} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </a>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => (setOpen(false), setAdding(true))}
            style={{ ...smallButton(false), justifyContent: 'center', margin: '8px 4px 2px', padding: '8px 10px', color: '#bfdbfe', borderColor: theme.tint('running', 0.5), fontSize: 13 }}
          >
            ＋ {s.add}
          </button>
        </div>
      )}
      {adding && <AddProjectDialog onClose={() => setAdding(false)} onCreated={id => window.location.assign(`/canvas/${id}`)} />}
    </div>
  )
}

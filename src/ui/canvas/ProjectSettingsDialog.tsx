'use client'

import { useEffect, useRef } from 'react'
import type { ProjectSettings } from '@/engine/project-settings'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { AgentSettings } from './AgentSettings'
import { ProjectGithub } from './GithubConnect'
import { ProjectMemory } from './ProjectMemory'

/** The project's own settings, in their own window: its folder, its test command, the low-risk switch, its memory. */
export function ProjectSettingsDialog({ settings, onClose, onSaved }: { settings: ProjectSettings; onClose: () => void; onSaved: (next: ProjectSettings) => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', background: 'rgba(5, 7, 11, 0.6)' }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={strings.projectSettings.title}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(560px, calc(100% - 32px))', maxHeight: 'calc(100% - 48px)', overflowY: 'auto', display: 'grid', gap: 12, padding: 20, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.55)', outline: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="factory-display" style={{ margin: 0, fontSize: 22 }}>{strings.projectSettings.title}</h2>
          <button type="button" aria-label={strings.setup.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 16 }}>
            ✕
          </button>
        </div>
        <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>{strings.projectSettings.what}</span>
        <AgentSettings settings={settings} onSaved={onSaved} />
        <ProjectGithub projectId={settings.projectId} />
        <ProjectMemory projectId={settings.projectId} />
      </div>
    </div>
  )
}

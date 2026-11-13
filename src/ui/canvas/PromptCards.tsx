'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Prompt, PromptKind } from '@/engine/prompts'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { whenText } from './PastTasks'

const TONE: Record<PromptKind, string> = {
  request: theme.running,
  followUp: theme.running,
  memory: '#2dd4bf',
  replan: theme.waiting,
  changes: theme.waiting,
  reviewer: '#a78bfa',
  approvedNote: theme.passed,
  rejectedNote: theme.failed,
}

/** The block a prompt belongs to: where in the process it was asked. */
export const PROMPT_BLOCK: Record<PromptKind, 'input' | 'plan' | 'review' | 'human'> = {
  request: 'input',
  followUp: 'input',
  memory: 'input',
  replan: 'plan',
  reviewer: 'review',
  changes: 'human',
  approvedNote: 'human',
  rejectedNote: 'human',
}

/** What was asked on this task, read again whenever `refreshKey` changes. */
export function usePrompts(runId: string | null, refreshKey: string): Prompt[] {
  const [state, setState] = useState<{ runId: string; prompts: Prompt[] } | null>(null)
  useEffect(() => {
    if (!runId) return
    let live = true
    fetch(`/api/runs/${runId}/prompts`)
      .then(r => (r.ok ? (r.json() as Promise<{ prompts: Prompt[] }>) : null))
      .then(d => live && d && setState({ runId, prompts: d.prompts }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [runId, refreshKey])
  return state && state.runId === runId ? state.prompts : []
}

/**
 * On a card, what was asked at that step, oldest first: each as a small quoted note saying who asked and when, three
 * lines long; it opens to its whole text.
 */
export function AskedStrip({ prompts }: { prompts: readonly Prompt[] }) {
  const [open, setOpen] = useState<Prompt | null>(null)
  if (prompts.length === 0) return null
  return (
    <div
      data-testid="asked-strip"
      className="nodrag"
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      style={{ display: 'grid', gap: 6, marginTop: 10 }}
    >
      {prompts.map((p, i) => (
        <button
          key={`${p.at}-${i}`}
          type="button"
          onClick={() => setOpen(p)}
          title={strings.prompts.open}
          style={{ textAlign: 'left', display: 'grid', gap: 3, padding: '7px 9px', borderRadius: 8, border: `1px solid ${theme.border}`, borderLeft: `3px solid ${TONE[p.kind]}`, background: '#0d1118', color: '#d6dce6', cursor: 'pointer', opacity: p.earlier ? 0.75 : 1 }}
        >
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 9.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: TONE[p.kind] }}>
            <span>
              {p.earlier ? `${strings.prompts.earlier} · ` : ''}
              {strings.prompts.kind[p.kind]}
            </span>
            <span style={{ fontWeight: 600, letterSpacing: 0, textTransform: 'none', color: theme.dim }}>{whenText(p.at)}</span>
          </span>
          <span style={{ fontSize: 12.5, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{p.text}</span>
        </button>
      ))}
      {open && <PromptModal prompt={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function PromptModal({ prompt, onClose }: { prompt: Prompt; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(5, 7, 11, 0.7)', display: 'grid', gridTemplateRows: 'minmax(0, 1fr)', placeItems: 'center', padding: 24 }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={strings.prompts.kind[prompt.kind]}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(680px, 100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: theme.bg, border: `1px solid ${theme.border}`, borderTop: `3px solid ${TONE[prompt.kind]}`, borderRadius: 14, boxShadow: '0 30px 80px rgba(0,0,0,0.6)', outline: 'none', color: '#e6e9ef' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: TONE[prompt.kind] }}>
            {strings.prompts.kind[prompt.kind]} <span style={{ fontWeight: 600, letterSpacing: 0, textTransform: 'none', color: theme.dim }}>· {new Date(prompt.at).toLocaleString()}</span>
          </div>
          <button type="button" aria-label={strings.prompts.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 6 }}>
            ✕
          </button>
        </header>
        <div style={{ padding: 16, overflowY: 'auto', fontSize: 14.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{prompt.text}</div>
      </div>
    </div>,
    document.body,
  )
}

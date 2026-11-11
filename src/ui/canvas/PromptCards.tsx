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
  replan: theme.waiting,
  changes: theme.waiting,
  reviewer: '#a78bfa',
  approvedNote: theme.passed,
  rejectedNote: theme.failed,
}

/**
 * What was asked on this task, as a row of small cards under its title, oldest first: the request, each change or new
 * plan the person asked for, what a reviewer sent back. A card opens to show its whole text.
 */
export function PromptCards({ runId, refreshKey }: { runId: string; refreshKey: string | number }) {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [open, setOpen] = useState<Prompt | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/prompts`)
      .then(r => (r.ok ? (r.json() as Promise<{ prompts: Prompt[] }>) : null))
      .then(d => live && d && setPrompts(d.prompts))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [runId, refreshKey])

  if (prompts.length === 0) return null
  return (
    <>
      <ol
        data-testid="prompt-cards"
        aria-label={strings.prompts.title}
        style={{ position: 'absolute', top: 72, left: 24, zIndex: 4, maxWidth: 'calc(100% - 540px)', margin: 0, padding: '2px 2px 6px', listStyle: 'none', display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}
      >
        {prompts.map((p, i) => (
          <li key={`${p.at}-${i}`} style={{ flex: 'none' }}>
            <button
              type="button"
              onClick={() => setOpen(p)}
              title={strings.prompts.open}
              style={{ width: 240, height: 92, textAlign: 'left', display: 'grid', gridTemplateRows: 'auto 1fr', gap: 4, padding: '8px 10px', borderRadius: 10, border: `1px solid ${theme.border}`, borderLeft: `3px solid ${TONE[p.kind]}`, background: 'rgba(17, 22, 31, 0.92)', color: '#d6dce6', cursor: 'pointer', boxShadow: '0 8px 20px rgba(0,0,0,0.3)' }}
            >
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: TONE[p.kind] }}>
                <span>
                  {i + 1}. {strings.prompts.kind[p.kind]}
                </span>
                <span style={{ fontWeight: 600, letterSpacing: 0, textTransform: 'none', color: theme.dim }}>{whenText(p.at)}</span>
              </span>
              <span style={{ fontSize: 12.5, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{p.text}</span>
            </button>
          </li>
        ))}
      </ol>
      {open && <PromptModal prompt={open} onClose={() => setOpen(null)} />}
    </>
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(5, 7, 11, 0.7)', display: 'grid', placeItems: 'center', padding: 24 }}>
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

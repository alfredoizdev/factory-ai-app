'use client'

import { forwardRef } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { RUN_INPUT_ID } from './Canvas'
import { WorkingSpinner } from './BlockCard'
import { Composer, imagesBusy, readyImageIds, type ComposerImage } from './Composer'
import { GateSection } from './GatePanel'
import { ResultSection } from './ResultPanel'
import type { ShipState } from '@/engine/ship'

export type CardMode = 'idle' | 'working' | 'waiting' | 'done'

const FRAME: Record<CardMode, { tone: 'running' | 'waiting' | 'passed'; from: string; to: string; strength: number }> = {
  idle: { tone: 'running', from: '#141b27', to: '#10151e', strength: 0.35 },
  working: { tone: 'running', from: '#121a29', to: '#0f1520', strength: 0.5 },
  waiting: { tone: 'waiting', from: '#1f1a10', to: '#16130d', strength: 0.55 },
  done: { tone: 'passed', from: '#0f1f16', to: '#0c1711', strength: 0.5 },
}

/**
 * The one card where a person talks to the agents, there from the start. What it holds follows the run: a request
 * before one starts; the work in progress; the decision when the run waits for them; the result and the next change
 * once it is approved. One composer serves every moment, so there is never a second box to wonder about.
 */
export const CommandCard = forwardRef<
  HTMLElement,
  {
    mode: CardMode
    runId: string | null
    risk?: { level: 'low' | 'high'; reasons: string[] }
    text: string
    onText: (v: string) => void
    images: ComposerImage[]
    onImages: (update: (prev: ComposerImage[]) => ComposerImage[]) => void
    /** Starts a fresh run from the composer (the same as Run in the top bar). */
    onRun: () => void
    canRun: boolean
    onFollowUp: (runId: string) => void
    onShipState?: (state: ShipState) => void
    /** Empties the composer once what it held has been sent. */
    onSent: () => void
    /** The branches a fresh task may start from, the project's main branch first. Empty: not shown. */
    startOptions?: readonly string[]
    /** The one chosen; a fresh task starts from the main branch unless the person picks another. */
    startFrom?: string | null
    onStartFrom?: (branch: string) => void
  }
>(function CommandCard({ mode, runId, risk, text, onText, images, onImages, onRun, canRun, onFollowUp, onSent, startOptions = [], startFrom, onStartFrom, onShipState }, ref) {
  const frame = FRAME[mode]
  const label = mode === 'waiting' ? strings.gate.reasonLabel : mode === 'done' ? strings.followUp.title : strings.run.requestLabel
  const placeholder = mode === 'waiting' ? strings.gate.reasonPlaceholder : mode === 'done' ? strings.followUp.placeholder : strings.run.requestPlaceholder
  const composer = (
    <Composer
      inputId={RUN_INPUT_ID}
      label={label}
      placeholder={placeholder}
      text={text}
      onText={onText}
      images={images}
      onImages={onImages}
      onSubmit={mode === 'idle' && canRun ? onRun : undefined}
    />
  )
  return (
    <section
      ref={ref}
      tabIndex={-1}
      data-testid="command-card"
      data-mode={mode}
      aria-label={mode === 'waiting' ? strings.gate.title : mode === 'done' ? strings.delivery.title : strings.sidebar.runTitle}
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 5,
        width: 460,
        maxWidth: 'calc(100% - 32px)',
        maxHeight: 'calc(100% - 32px)',
        overflowY: 'auto',
        // Never sideways: a long branch name or path wraps or is cut short instead of widening the card.
        overflowX: 'hidden',
        background: `linear-gradient(180deg, ${frame.from} 0%, ${frame.to} 100%)`,
        border: `1px solid ${theme.tint(frame.tone, frame.strength)}`,
        borderRadius: 14,
        boxShadow: `0 0 0 1px ${theme.tint(frame.tone, 0.15)}, 0 0 30px ${theme.tint(frame.tone, mode === 'idle' ? 0.06 : 0.16)}, 0 18px 40px rgba(0,0,0,0.55)`,
        padding: 16,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: 12,
        outline: 'none',
      }}
    >
      {mode === 'idle' && (
        <>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{strings.sidebar.runTitle}</div>
          {startOptions.length === 1 && (
            <div data-testid="starts-from" style={{ fontSize: 12, color: theme.dim, marginTop: -6, overflowWrap: 'anywhere' }}>
              {strings.delivery.startsFrom(startOptions[0]!)}
            </div>
          )}
          {startOptions.length > 1 && (
            // The folder is on another branch: say where the task starts, and let the person choose that one instead.
            <label data-testid="starts-from" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.dim, marginTop: -6 }}>
              {strings.delivery.startFromLabel}
              <select
                value={startFrom ?? startOptions[0]}
                onChange={e => onStartFrom?.(e.target.value)}
                style={{ flex: 1, minWidth: 0, padding: '4px 6px', background: theme.bg, color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 6, fontSize: 12 }}
              >
                {startOptions.map((b, i) => (
                  <option key={b} value={b}>
                    {i === 0 ? strings.delivery.mainOption(b) : strings.delivery.currentOption(b)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {composer}
          <button
            type="button"
            disabled={!canRun}
            onClick={onRun}
            style={{
              padding: '9px 12px',
              borderRadius: 8,
              border: `1px solid ${canRun ? theme.running : theme.border}`,
              background: canRun ? theme.running : 'transparent',
              color: canRun ? '#fff' : theme.skipped,
              fontWeight: 700,
              cursor: canRun ? 'pointer' : 'not-allowed',
            }}
          >
            ▶ {strings.run.run} <span style={{ fontWeight: 400, opacity: 0.8, fontSize: 12 }}>⌘↵</span>
          </button>
        </>
      )}
      {mode === 'working' && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, color: '#cfe0ff' }}>
          <WorkingSpinner blockId="card" size={20} />
          {strings.card.working}
        </div>
      )}
      {mode === 'waiting' && runId && (
        <GateSection runId={runId} risk={risk} note={text} imageIds={readyImageIds(images)} imagesBusy={imagesBusy(images)} composer={composer} onSent={onSent} />
      )}
      {mode === 'done' && runId && (
        <ResultSection
          onShipState={onShipState}
          runId={runId}
          note={text}
          imageIds={readyImageIds(images)}
          imagesBusy={imagesBusy(images)}
          composer={composer}
          onFollowUp={id => {
            onSent()
            onFollowUp(id)
          }}
        />
      )}
    </section>
  )
})

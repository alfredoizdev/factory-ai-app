'use client'

import { forwardRef } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { RUN_INPUT_ID } from './Canvas'
import { WorkingSpinner } from './BlockCard'
import { Composer, imagesBusy, readyImageIds, type ComposerImage, type ComposerSend } from './Composer'
import { GateSection } from './GatePanel'
import { PlanSection } from './PlanSection'
import { ResultSection } from './ResultPanel'
import { COMMAND_CARD_WIDTH } from './layout'
import { CardSkeleton } from './Skeleton'
import type { ShipState } from '@/engine/ship'

export type CardMode = 'idle' | 'working' | 'plan' | 'waiting' | 'done'

const FRAME: Record<CardMode, { tone: 'running' | 'waiting' | 'passed'; from: string; to: string; strength: number }> = {
  idle: { tone: 'running', from: '#141b27', to: '#10151e', strength: 0.35 },
  working: { tone: 'running', from: '#121a29', to: '#0f1520', strength: 0.5 },
  plan: { tone: 'waiting', from: '#1f1a10', to: '#16130d', strength: 0.55 },
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
    /** The task is still loading: placeholders instead of a card that would change under the person's eyes. */
    loading?: boolean
    /** Set when the open run's working copy is on another computer: what needs it is not offered here. */
    away?: { machine: string | null } | null
    /** The name for a new task, optional. Absent: no field. */
    taskName?: string
    onTaskName?: (v: string) => void
  }
>(function CommandCard({ mode, runId, risk, text, onText, images, onImages, onRun, canRun, onFollowUp, onSent, startOptions = [], startFrom, onStartFrom, onShipState, loading = false, taskName, onTaskName, away = null }, ref) {
  const frame = FRAME[mode]
  const label = mode === 'plan' ? strings.plan.replanLabel : mode === 'waiting' ? strings.gate.reasonLabel : mode === 'done' ? strings.followUp.title : strings.run.requestLabel
  const placeholder = mode === 'plan' ? strings.plan.replanPlaceholder : mode === 'waiting' ? strings.gate.reasonPlaceholder : mode === 'done' ? strings.followUp.placeholder : strings.run.requestPlaceholder
  const withSend = (send?: ComposerSend) => (
    <Composer
      send={send}
      minHeight={mode === 'waiting' || mode === 'done' || mode === 'plan' ? 96 : undefined}
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
  const composer = withSend()
  return (
    <section
      ref={ref}
      tabIndex={-1}
      data-testid="command-card"
      data-mode={mode}
      aria-label={mode === 'plan' ? strings.plan.title : mode === 'waiting' ? strings.gate.title : mode === 'done' ? strings.delivery.title : strings.sidebar.runTitle}
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 5,
        width: COMMAND_CARD_WIDTH,
        maxWidth: 'calc(100% - 32px)',
        // Below the Tasks button at the top right (12px down, about 34px tall), never under it.
        maxHeight: 'calc(100% - 72px)',
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
      {loading && <CardSkeleton />}
      {!loading && mode === 'idle' && (
        <>
          <div className="factory-display" style={{ fontSize: 17, fontWeight: 700 }}>{strings.sidebar.runTitle}</div>
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
          {onTaskName && (
            <label style={{ display: 'grid', gap: 4, fontSize: 12.5, fontWeight: 600, color: theme.dim }}>
              <span>
                {strings.title.label} <span style={{ fontWeight: 400 }}>{strings.title.optional}</span>
              </span>
              <input
                value={taskName ?? ''}
                maxLength={60}
                placeholder={strings.title.placeholder}
                onChange={e => onTaskName(e.target.value)}
                style={{ font: 'inherit', fontSize: 13.5, fontWeight: 400, padding: '7px 10px', background: theme.card, color: '#e6e9ef', border: `1px solid ${theme.border}`, borderRadius: 8 }}
              />
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
            ▶ {strings.run.run} <span style={{ fontWeight: 400, opacity: 0.8, fontSize: 12 }}>↵</span>
          </button>
        </>
      )}
      {!loading && mode === 'working' && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, color: '#cfe0ff' }}>
          <WorkingSpinner blockId="card" size={20} />
          {strings.card.working}
        </div>
      )}
      {!loading && mode === 'plan' && runId && <PlanSection away={away} runId={runId} note={text} composer={withSend} onSent={onSent} />}
      {!loading && mode === 'waiting' && runId && (
        <GateSection away={away} runId={runId} risk={risk} note={text} imageIds={readyImageIds(images)} imagesBusy={imagesBusy(images)} composer={withSend} onSent={onSent} />
      )}
      {!loading && mode === 'done' && runId && (
        <ResultSection
          away={away}
          onShipState={onShipState}
          runId={runId}
          note={text}
          imageIds={readyImageIds(images)}
          imagesBusy={imagesBusy(images)}
          composer={withSend}
          onFollowUp={id => {
            onSent()
            onFollowUp(id)
          }}
        />
      )}
    </section>
  )
})

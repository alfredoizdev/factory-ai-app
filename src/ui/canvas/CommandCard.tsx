'use client'

import { FailedSection, type FailureActions } from './FailurePanel'
import { forwardRef, useId, useState } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { RUN_INPUT_ID } from './Canvas'
import { WorkingSpinner } from './BlockCard'
import { Composer, imagesBusy, readyImageIds, type ComposerImage, type ComposerSend } from './Composer'
import { GateSection } from './GatePanel'
import { QuestionSection } from './QuestionPanel'
import type { ReviewRecord } from './useReviewRecord'
import { PlanSection } from './PlanSection'
import { ResultSection } from './ResultPanel'
import { COMMAND_CARD_WIDTH } from './layout'
import { CardSkeleton } from './Skeleton'
import type { ShipState } from '@/engine/ship'

export type CardMode = 'idle' | 'working' | 'plan' | 'question' | 'waiting' | 'done' | 'failed'

const FRAME: Record<CardMode, { tone: 'running' | 'waiting' | 'passed' | 'failed'; from: string; to: string; strength: number }> = {
  idle: { tone: 'running', from: '#141b27', to: '#10151e', strength: 0.35 },
  working: { tone: 'running', from: '#121a29', to: '#0f1520', strength: 0.5 },
  plan: { tone: 'waiting', from: '#1f1a10', to: '#16130d', strength: 0.55 },
  question: { tone: 'waiting', from: '#1f1a10', to: '#16130d', strength: 0.55 },
  waiting: { tone: 'waiting', from: '#1f1a10', to: '#16130d', strength: 0.55 },
  done: { tone: 'passed', from: '#0f1f16', to: '#0c1711', strength: 0.5 },
  failed: { tone: 'failed', from: '#211214', to: '#170e10', strength: 0.5 },
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
    /** What the app made of the plan on screen: its reasons, one sentence first. */
    planMeasure?: { reasons: string[]; question?: string }
    /** The per-task box on a fresh task: stop for the person at the plan and before the change is kept. */
    stopForMe?: boolean
    onStopForMe?: (v: boolean) => void
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
    /** Something was recorded about a run that had ended (kept, sent, merged): the canvas listens again. */
    onRecorded?: () => void
    /** Set when the open run's working copy is on another computer: what needs it is not offered here. */
    away?: { machine: string | null } | null
    /** The name for a new task, optional. Absent: no field. */
    taskName?: string
    onTaskName?: (v: string) => void
    /** Filled, while a failed task is on screen, with what the failed block's buttons do. */
    failureActions?: { current: FailureActions | null }
    onCanContinue?: (can: boolean) => void
    /** Opens the Human check window, where the change being decided on is shown. */
    onSeeChanges?: () => void
    /** What the reviewers reported and the question the run waits on; read again by the screen when the run's events say it changed. */
    record?: ReviewRecord | null
    /** The record could not be read the last time it was tried. */
    recordFailed?: boolean
    /** The latest event that changes the record, the one the record was read for, and the question the events say is open. */
    recordMark?: number
    recordReadMark?: number
    askedId?: string | null
    onRecordChanged?: () => void
    /** The reviewers ran on this task: the human check lists what they found. */
    showFindings?: boolean
    /** The browser's notices: whether to offer them, and what pressing the offer does. Shown while the task works. */
    notice?: { offer: 'ask' | 'on' | 'blocked' | 'none'; onAllow: () => void }
  }
>(function CommandCard({ planMeasure, stopForMe = false, onStopForMe, onSeeChanges, record = null, recordFailed = false, recordMark = 0, recordReadMark = 0, askedId = null, onRecordChanged, showFindings = false, notice, mode, runId, risk, text, onText, images, onImages, onRun, canRun, onFollowUp, onSent, startOptions = [], startFrom, onStartFrom, onShipState, loading = false, taskName, onTaskName, away = null, onRecorded, failureActions, onCanContinue }, ref) {
  const frame = FRAME[mode]
  const label = mode === 'plan' ? strings.plan.replanLabel : mode === 'waiting' ? strings.gate.reasonLabel : mode === 'done' ? strings.followUp.title : mode === 'failed' ? strings.failure.label : strings.run.requestLabel
  const placeholder = mode === 'plan' ? strings.plan.replanPlaceholder : mode === 'waiting' ? strings.gate.reasonPlaceholder : mode === 'done' ? strings.followUp.placeholder : mode === 'failed' ? strings.failure.placeholder : strings.run.requestPlaceholder
  const withSend = (send?: ComposerSend) => (
    <Composer
      send={send}
      minHeight={mode === 'waiting' || mode === 'done' || mode === 'plan' || mode === 'failed' ? 96 : undefined}
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
      aria-label={mode === 'plan' ? strings.plan.title : mode === 'question' ? strings.question.title : mode === 'waiting' ? strings.gate.title : mode === 'done' ? strings.delivery.title : strings.sidebar.runTitle}
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
          {onStopForMe && <StopForMe checked={stopForMe} onChange={onStopForMe} />}
          {/* Sent like every other message in this card: the arrow inside the box, or Enter. */}
          {withSend({ label: strings.run.send, onSend: onRun, enabled: canRun })}
        </>
      )}
      {!loading && mode === 'working' && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, color: '#cfe0ff' }}>
          <WorkingSpinner blockId="card" size={20} />
          {strings.card.working}
        </div>
      )}
      {!loading && mode === 'working' && notice && <NoticeOffer notice={notice} />}
      {!loading && mode === 'plan' && runId && <PlanSection measure={planMeasure} away={away} runId={runId} note={text} composer={withSend} onSent={onSent} />}
      {!loading && mode === 'question' && runId && <QuestionSection runId={runId} record={record} failed={recordFailed} mark={recordMark} readMark={recordReadMark} askedId={askedId} onChanged={() => onRecordChanged?.()} />}
      {!loading && mode === 'waiting' && runId && (
        <GateSection findings={showFindings ? record?.findings : undefined} touched={record?.touched} away={away} runId={runId} risk={risk} note={text} imageIds={readyImageIds(images)} imagesBusy={imagesBusy(images)} composer={withSend} onSent={onSent} onSeeChanges={onSeeChanges} />
      )}
      {!loading && mode === 'done' && runId && (
        <ResultSection
          away={away}
          onRecorded={onRecorded}
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
      {!loading && mode === 'failed' && runId && (
        <FailedSection
          runId={runId}
          note={text}
          imageIds={readyImageIds(images)}
          imagesBusy={imagesBusy(images)}
          composer={withSend}
          onText={onText}
          actionsRef={failureActions}
          onCanContinue={onCanContinue}
          onFollowUp={id => {
            onSent()
            onFollowUp(id)
          }}
        />
      )}
    </section>
  )
})

/** The per-task box. "What is this?" opens its explanation right here, one click away and reachable by keyboard. */
function StopForMe({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const why = useId()
  return (
    <div data-testid="stop-for-me" style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#d6dce6', cursor: 'pointer' }}>
          <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
          {strings.composer.stopForMe}
        </label>
        <button type="button" aria-expanded={open} aria-controls={why} onClick={() => setOpen(o => !o)} style={{ padding: 0, background: 'none', border: 'none', color: '#9cc2ff', fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}>
          {strings.composer.stopForMeWhat}
        </button>
      </div>
      {open && (
        <span id={why} style={{ fontSize: 12.5, lineHeight: 1.45, color: theme.dim, overflowWrap: 'anywhere' }}>
          {strings.composer.stopForMeWhy}
        </span>
      )}
    </div>
  )
}

/** Once, while the task works: the button that lets the browser tell the person; after the press, what the browser answered. */
function NoticeOffer({ notice }: { notice: { offer: 'ask' | 'on' | 'blocked' | 'none'; onAllow: () => void } }) {
  const [pressed, setPressed] = useState(false)
  const note = { fontSize: 12, lineHeight: 1.4, color: theme.dim, margin: 0 }
  if (notice.offer === 'ask')
    return (
      <button
        type="button"
        onClick={() => {
          setPressed(true)
          notice.onAllow()
        }}
        style={{ justifySelf: 'start', textAlign: 'left', padding: '5px 10px', borderRadius: 8, border: `1px solid ${theme.border}`, background: 'transparent', color: 'inherit', fontSize: 12.5, cursor: 'pointer' }}
      >
        {strings.tell.offer}
      </button>
    )
  if (pressed && notice.offer === 'on') return <p style={note}>{strings.tell.on}</p>
  if (pressed && notice.offer === 'blocked') return <p style={note}>{strings.tell.blocked}</p>
  return null
}

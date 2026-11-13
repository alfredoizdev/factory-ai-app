'use client'

import { useState, type ReactNode } from 'react'
import { STAGE_ORDER, type Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'
import { brand } from '@/ui/brand'
import { Logo } from '@/ui/Logo'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { BlockDetailsDialog } from './BlockDetails'
import { visualStateOf, type NodeRunView } from './BlockCard'
import { COMMAND_CARD_WIDTH } from './layout'
import { TypeMark } from './TypeMark'

const s = strings.steps

/** One card of the row: a step of the flow, or several checks (tests, lint, build) shown as one. */
type Step = { id: string; label: string; blocks: Block[] }

/** The flow as a row of steps, in the order the task goes through them: several blocks of one stage (tests, lint, build) are one step. */
export function stepsOf(blocks: readonly Block[]): Step[] {
  return STAGE_ORDER.map(kind => blocks.filter(b => b.kind === kind && b.enabled))
    .filter(group => group.length > 0)
    .map(group => ({ id: group[0]!.id, label: group.length > 1 && group[0]!.kind === 'tests' ? s.checks : group[0]!.label, blocks: group }))
}

/** A step made of several checks stands where the least finished of them stands. */
const ORDER: NodeState[] = ['failed', 'blocked', 'waiting_approval', 'running', 'queued', 'cancelled', 'skipped', 'passed']
function stateOf(step: Step, views: Record<string, NodeRunView>): NodeState {
  const states = step.blocks.map(b => views[b.id]?.state ?? 'queued')
  return ORDER.find(o => states.includes(o)) ?? 'queued'
}

const colourOf = (state: NodeState) => (state === 'passed' ? brand.green : state === 'queued' || state === 'skipped' || state === 'cancelled' ? brand.faint : theme[visualStateOf(state)])

function Mark({ state, size = 20 }: { state: NodeState; size?: number }) {
  const colour = colourOf(state)
  const done = state === 'passed'
  return (
    <span aria-hidden="true" style={{ width: size, height: size, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', background: done ? colour : 'transparent', border: `1.5px solid ${colour}`, color: done ? brand.onGreen : colour, fontSize: size * 0.55, fontWeight: 900 }}>
      {done ? '✓' : state === 'failed' ? '!' : state === 'running' ? '•' : ''}
    </span>
  )
}

/**
 * The task as a row of steps, with the chosen step's details under it. The same task and the same data as the canvas,
 * laid out to be read rather than arranged: nothing here moves or edits the flow.
 */
export function StepsView({
  blocks,
  views,
  runId,
  title,
  log,
  blank = false,
  pr = null,
  away = null,
  onEditFlow,
}: {
  blocks: readonly Block[]
  views: Record<string, NodeRunView>
  runId: string | null
  /** The open task's title, above the row. */
  title?: ReactNode
  /** "What is happening", in the left column. */
  log?: ReactNode
  /** Nothing is open: the row is not drawn, so the screen can say what to do. */
  blank?: boolean
  pr?: { number: number; url: string } | null
  away?: { machine: string | null } | null
  /** Changing the steps themselves is done on the canvas: this goes there. */
  onEditFlow: () => void
}) {
  const steps = stepsOf(blocks)
  // The step that matters now: the one that failed, waits or works; else the last one, where the task ended.
  const live = steps.find(st => ['failed', 'waiting_approval', 'running', 'blocked'].includes(stateOf(st, views)))
  const fallback = (live ?? steps[steps.length - 1])?.id ?? null
  const [picked, setPicked] = useState<{ run: string | null; step: string; block: string } | null>(null)
  // A choice made by hand lasts for the task it was made on.
  const mine = picked && picked.run === runId ? picked : null
  const stepId = mine?.step ?? fallback
  const step = steps.find(st => st.id === stepId) ?? null
  const blockId = step ? (mine && step.blocks.some(b => b.id === mine.block) ? mine.block : (step.blocks.find(b => (views[b.id]?.state ?? 'queued') !== 'passed') ?? step.blocks[0]!).id) : null

  return (
    <div data-testid="steps-view" style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)', background: brand.bg, color: brand.text, fontFamily: brand.sans }}>
      <aside style={{ minHeight: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', borderRight: `1px solid ${brand.line}` }}>
        <p style={{ margin: 0, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 10, fontFamily: brand.mono, fontSize: 12, letterSpacing: '0.2em', textTransform: 'uppercase', color: brand.green, borderBottom: `1px solid ${brand.line}` }}>
          <Logo size={20} accent={brand.green} />
          {strings.welcome.eyebrow}
        </p>
        <div style={{ minHeight: 0, overflowY: 'auto', padding: '14px 14px 18px', display: 'grid', gap: 10, alignContent: 'start', scrollbarWidth: 'thin' }}>
          <h2 style={{ margin: '0 4px', fontFamily: brand.mono, fontSize: 11.5, fontWeight: 500, letterSpacing: '0.2em', textTransform: 'uppercase', color: brand.quiet }}>{strings.events.barTitle}</h2>
          {log ?? <span style={{ margin: '0 4px', fontSize: 13, color: brand.faint }}>{s.noLog}</span>}
        </div>
        <button type="button" onClick={onEditFlow} style={{ margin: 14, padding: '9px 12px', borderRadius: 9, border: `1px solid ${brand.line}`, background: 'transparent', color: brand.quiet, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {s.editFlow}
        </button>
      </aside>

      <main style={{ minWidth: 0, minHeight: 0, overflowY: 'auto', padding: `20px ${COMMAND_CARD_WIDTH + 40}px 40px 28px`, display: 'grid', gap: 22, alignContent: 'start', scrollbarWidth: 'thin' }}>
        {/* The title places itself for the canvas (from the top left corner): this box is the corner it starts from here. */}
        {title && <div style={{ position: 'relative', height: 44, margin: '-18px 0 0 -24px' }}>{title}</div>}
        {!blank && (
          // The row wraps onto a second line on a narrow screen, so no step is ever cut off.
          <ol data-testid="steps-row" aria-label={s.rowLabel} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {steps.map(st => {
              const state = stateOf(st, views)
              const on = st.id === stepId
              const group = st.blocks.length > 1
              return (
                <li key={st.id} style={{ flex: '1 1 118px', maxWidth: 190, display: 'grid' }}>
                  <div style={{ display: 'grid', gap: 10, alignContent: 'start', padding: 12, borderRadius: 12, border: `1px solid ${on ? brand.green : brand.line}`, background: brand.card }}>
                    <button
                      type="button"
                      data-testid={`step-${st.id}`}
                      aria-current={on ? 'step' : undefined}
                      onClick={() => setPicked({ run: runId, step: st.id, block: st.blocks[0]!.id })}
                      style={{ display: 'grid', gap: 10, padding: 0, background: 'none', border: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <TypeMark kind={st.blocks[0]!.kind} colour={brand.quiet} size={30} />
                        <Mark state={state} />
                      </span>
                      <span style={{ display: 'grid', gap: 3 }}>
                        <strong style={{ fontSize: 14.5, letterSpacing: '-0.01em' }}>{st.label}</strong>
                        <span style={{ fontFamily: brand.mono, fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: colourOf(state) }}>{strings.canvas.stateLabel[state]}</span>
                      </span>
                    </button>
                    {group && (
                      // Each check of the group, with its own mark: picking one shows that check's details.
                      <ul style={{ listStyle: 'none', margin: 0, padding: '8px 0 0', display: 'grid', gap: 4, borderTop: `1px solid ${brand.line}` }}>
                        {st.blocks.map(b => {
                          const bs = views[b.id]?.state ?? 'queued'
                          return (
                            <li key={b.id}>
                              <button
                                type="button"
                                data-testid={`check-${b.id}`}
                                onClick={() => setPicked({ run: runId, step: st.id, block: b.id })}
                                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', borderRadius: 6, background: on && blockId === b.id ? '#222222' : 'none', border: 'none', color: brand.quiet, font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}
                              >
                                <Mark state={bs} size={14} />
                                {b.label}
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {!blank && runId && blockId && step && (
          <BlockDetailsDialog
            key={`inline-${runId}-${blockId}`}
            inline
            runId={runId}
            blockId={blockId}
            label={step.blocks.find(b => b.id === blockId)?.label ?? step.label}
            view={views[blockId]}
            pr={pr}
            away={away}
            onClose={() => undefined}
          />
        )}
        {!blank && !runId && <p style={{ margin: 0, fontSize: 14, color: brand.quiet }}>{s.beforeRun}</p>}
      </main>
    </div>
  )
}

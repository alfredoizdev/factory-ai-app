'use client'

import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { STAGE_ORDER, type Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'
import { brand } from '@/ui/brand'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { visualStateOf, WorkingSpinner } from './BlockCard'
import { DOCKED_WIDTH } from './layout'
import { TypeMark } from './TypeMark'

const s = strings.steps

/** One card of the row: a step of the flow, or several checks (tests, lint, build) shown as one. */
type Step = { id: string; label: string; blocks: Block[] }

/** The flow as a row of steps, in the order the task goes through them: several blocks of one stage (tests, lint, build) are one step. */
export function stepsOf(blocks: readonly Block[]): Step[] {
  return STAGE_ORDER.map(kind => blocks.filter(b => b.kind === kind))
    .filter(group => group.length > 0)
    .map(group => ({ id: group[0]!.id, label: group.length > 1 && group[0]!.kind === 'tests' ? s.checks : group[0]!.label, blocks: group }))
}

/** A step made of several checks stands where the least finished of them stands. */
const ORDER: NodeState[] = ['failed', 'blocked', 'waiting_approval', 'running', 'queued', 'cancelled', 'skipped', 'passed']
const LIVE: readonly string[] = ['failed', 'blocked', 'waiting_approval', 'running']

/** The step to show when the person has picked none: the one that failed, waits or works; else the last one, where the task ended. */
export function stepToShow(blocks: readonly Block[], stateOf: (id: string) => NodeState | null): string | null {
  const on = STAGE_ORDER.flatMap(kind => blocks.filter(b => b.kind === kind && b.enabled))
  return (on.find(b => LIVE.includes(stateOf(b.id) ?? '')) ?? on[on.length - 1])?.id ?? null
}

const colourOf = (state: NodeState | null) => (state === 'passed' ? brand.green : state === null || state === 'queued' || state === 'skipped' || state === 'cancelled' ? brand.faint : theme[visualStateOf(state)])

/** The colour a working or waiting step breathes in, as "r, g, b"; null for a step where nothing is happening now. */
const pulseOf = (state: NodeState | null) => (state === 'running' ? '59, 130, 246' : state === 'waiting_approval' ? '245, 158, 11' : null)

function Mark({ state, size = 22, id = 'step' }: { state: NodeState | null; size?: number; id?: string }) {
  // Working: the same turning ring the canvas uses, so "working" looks the same everywhere.
  if (state === 'running') return <WorkingSpinner blockId={`step-${id}`} size={size} />
  const colour = colourOf(state)
  const done = state === 'passed'
  return (
    <span aria-hidden="true" style={{ width: size, height: size, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', background: done ? colour : 'transparent', border: `1.5px solid ${colour}`, color: done ? brand.onGreen : colour, fontSize: size * 0.55, fontWeight: 900, lineHeight: 1 }}>
      {done ? '✓' : state === 'failed' ? '!' : state === 'waiting_approval' ? '•' : ''}
    </span>
  )
}

/**
 * The task as a row of steps, with the picked step's details under it. It stands where the canvas stands, inside the
 * same screen: the sidebar on its left adds, renames and removes these same steps, and its log points at them.
 */
export function StepsLane({
  blocks,
  stateOf,
  hasRun,
  pickedId,
  onPick,
  workOf,
  title,
  detail,
  blank = false,
  loading = false,
}: {
  blocks: readonly Block[]
  /** Where a block stands in the task on screen; null when it is not part of it, or there is no task. */
  stateOf: (id: string) => NodeState | null
  hasRun: boolean
  /** The block whose details are shown: a step's own, or one check of a group. */
  pickedId: string | null
  onPick: (blockId: string) => void
  /** What a block of the task says about its work: its sentence and the things it did, newest last. */
  workOf?: (id: string) => { summary: string; steps: readonly string[] } | null
  /** The open task's title, above the row. */
  title?: ReactNode
  /** The picked block's details, drawn under the row. */
  detail?: ReactNode
  /** Nothing is open: the row is not drawn, so the screen can say what to do. */
  blank?: boolean
  loading?: boolean
}) {
  const steps = stepsOf(blocks)
  const stepState = (st: Step): NodeState | null => {
    const states = st.blocks.filter(b => b.enabled).map(b => stateOf(b.id))
    return ORDER.find(o => states.includes(o)) ?? null
  }
  const label = (state: NodeState | null, off: boolean) => (off ? s.off : state ? strings.canvas.stateLabel[state] : hasRun ? s.notInTask : '')
  return (
    <div data-testid="steps-view" style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: `28px ${DOCKED_WIDTH + 36}px 56px 36px`, display: 'grid', gap: 28, alignContent: 'start', backgroundColor: brand.bg, backgroundImage: 'radial-gradient(circle, #2b2b2b 1px, transparent 1.5px)', backgroundSize: '24px 24px', backgroundAttachment: 'local', color: brand.text, fontFamily: brand.sans, scrollbarWidth: 'thin', scrollbarColor: `${brand.line} transparent`, opacity: loading ? 0.4 : 1 }}>
      {/* The title places itself for the canvas (from the top left corner): this box is the corner it starts from here. */}
      {title && <div style={{ position: 'relative', height: 44, margin: '-18px 0 14px -24px' }}>{title}</div>}
      {!blank && (
        // The row wraps onto a second line on a narrow screen, so no step is ever cut off.
        <ol data-testid="steps-row" aria-label={s.rowLabel} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', rowGap: 12, alignItems: 'flex-start' }}>
          {steps.map((st, i) => {
            const state = stepState(st)
            const off = st.blocks.every(b => !b.enabled)
            const on = st.blocks.some(b => b.id === pickedId)
            const group = st.blocks.length > 1
            const before = i > 0 ? stepState(steps[i - 1]!) : null
            const pulse = off ? null : pulseOf(state)
            // The step where something is happening says what, on the card itself: its sentence, and the last thing it did.
            const liveBlock = off ? undefined : st.blocks.find(b => b.enabled && LIVE.includes(stateOf(b.id) ?? ''))
            const work = liveBlock ? (workOf?.(liveBlock.id) ?? null) : null
            const latest = work && state === 'running' ? work.steps[work.steps.length - 1] : undefined
            return (
              <Fragment key={st.id}>
                {i > 0 && <li aria-hidden="true" className={state === 'running' ? 'factory-step-flow' : undefined} style={{ flex: '0 1 22px', minWidth: 8, height: 2, marginTop: 34, ...(state === 'running' ? ({ '--pulse': pulse } as CSSProperties) : { background: before === 'passed' ? brand.green : brand.line, opacity: before === 'passed' ? 0.55 : 1 }) }} />}
                <li style={{ flex: work ? '2 1 230px' : '1 1 104px', maxWidth: work ? 320 : 170, minWidth: 104, display: 'grid', opacity: off ? 0.5 : 1 }}>
                  <div data-live={pulse ? 'true' : undefined} className={pulse ? 'factory-step-live' : undefined} style={{ display: 'grid', gap: 12, alignContent: 'start', padding: 14, borderRadius: 14, border: `1px solid ${pulse ? `rgb(${pulse})` : on ? brand.green : brand.line}`, background: on ? '#1c1f1c' : brand.card, ...(pulse ? ({ '--pulse': pulse } as CSSProperties) : { boxShadow: on ? '0 0 0 3px rgba(121, 220, 139, 0.12)' : 'none' }) }}>
                    <button
                      type="button"
                      data-testid={`step-${st.id}`}
                      aria-current={on ? 'step' : undefined}
                      onClick={() => onPick(st.blocks[0]!.id)}
                      style={{ display: 'grid', gap: 14, padding: 0, background: 'none', border: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <TypeMark kind={st.blocks[0]!.kind} colour={brand.text} size={34} />
                        <Mark state={state} id={st.id} />
                      </span>
                      <span style={{ display: 'grid', gap: 4 }}>
                        <strong style={{ fontSize: 16, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }}>{st.label}</strong>
                        <span style={{ minHeight: 13, fontFamily: brand.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: colourOf(state) }}>{label(state, off)}</span>
                      </span>
                    </button>
                    {work && (work.summary || latest) && (
                      <div data-testid={`step-work-${st.id}`} style={{ display: 'grid', gap: 6, paddingTop: 10, borderTop: `1px solid ${brand.line}`, fontSize: 13, lineHeight: 1.45 }}>
                        {work.summary && <span style={{ color: brand.text, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{work.summary}</span>}
                        {latest && latest !== work.summary && (
                          <span style={{ display: 'flex', gap: 7, color: brand.quiet, fontFamily: brand.mono, fontSize: 11.5 }}>
                            <span aria-hidden="true" style={{ color: colourOf(state) }}>›</span>
                            <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{latest}</span>
                          </span>
                        )}
                      </div>
                    )}
                    {group && (
                      // Each check of the group, with its own mark: picking one shows that check's details.
                      <ul style={{ listStyle: 'none', margin: 0, padding: '10px 0 0', display: 'grid', gap: 4, borderTop: `1px solid ${brand.line}` }}>
                        {st.blocks.map(b => (
                          <li key={b.id}>
                            <button
                              type="button"
                              data-testid={`check-${b.id}`}
                              aria-current={pickedId === b.id ? 'step' : undefined}
                              onClick={() => onPick(b.id)}
                              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 7, background: pickedId === b.id ? '#262a26' : 'none', border: 'none', color: b.enabled ? brand.quiet : brand.faint, font: 'inherit', fontSize: 13.5, textAlign: 'left', cursor: 'pointer' }}
                            >
                              <Mark state={b.enabled ? stateOf(b.id) : null} size={15} id={`check-${b.id}`} />
                              {b.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              </Fragment>
            )
          })}
        </ol>
      )}
      {!blank && (detail ?? <p style={{ margin: 0, maxWidth: '60ch', fontSize: 14.5, lineHeight: 1.55, color: brand.quiet }}>{hasRun ? s.notInTaskHint : s.beforeRun}</p>)}
    </div>
  )
}

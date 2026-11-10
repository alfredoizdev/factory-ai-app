'use client'

import { claimUsed, summarize, type SummaryInput } from '@/domain/summary'
import type { Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'
import type { Wire } from '@/ui/canvas/useRunStream'
import { visualStateOf } from '@/ui/canvas/BlockCard'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

// One line per block event. Every line carries the block it came from, coloured by the state THAT EVENT put the
// block in (a log records what happened, so a "Started" line stays blue after the card turns green), and a
// button that points at the block on the canvas. A line with no block is not shown here.

const EVENT_STATE: Record<string, NodeState> = {
  'node.queued': 'queued',
  'node.started': 'running',
  'node.waiting_approval': 'waiting_approval',
  'node.completed': 'passed',
  'node.failed': 'failed',
  'node.skipped': 'skipped',
  'node.cancelled': 'cancelled',
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/** The sentence for an event, and whether it is an unverified claim. Wording comes from summarize, never invented here. */
export function describeEvent(event: Wire, block: Block): { text: string; isClaim: boolean } {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  if (event.type === 'node.step') return { text: str(payload.text) ?? '', isClaim: false }
  if (event.type === 'node.started') return { text: strings.events.started, isClaim: false }
  if (event.type === 'node.waiting_approval') return { text: strings.events.waiting, isClaim: false }
  const state = EVENT_STATE[event.type]
  if (state === undefined) return { text: '', isClaim: false }
  const input: SummaryInput = {
    kind: block.kind,
    state,
    claim: event.type === 'node.completed' ? str(payload.summary) : event.type === 'node.failed' ? str(payload.message) : undefined,
    claimSource:
      event.type === 'node.failed'
        ? typeof payload.messageSource === 'string' ? payload.messageSource : undefined
        : typeof payload.summarySource === 'string' ? payload.summarySource : undefined,
    cause: event.type === 'node.failed' ? str(payload.cause) : undefined,
    skippedReason: event.type === 'node.skipped' ? str(payload.reason) : undefined,
  }
  return { text: summarize(input), isClaim: claimUsed(input) }
}

export function EventBar({ event, block, onPoint }: { event: Wire; block: Block; onPoint: (blockId: string) => void }) {
  const state = EVENT_STATE[event.type] ?? 'running' // a step happens while the block runs
  const colour = theme[visualStateOf(state)]
  const { text, isClaim } = describeEvent(event, block)
  return (
    <li
      data-testid="event-line"
      style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 8px', borderLeft: `3px solid ${colour}` }}
    >
      <strong style={{ color: colour, flexShrink: 0 }}>{block.label}</strong>
      <span style={{ flex: 1, minWidth: 0 }}>
        {isClaim && (
          <span title={strings.canvas.claimTitle} style={{ fontStyle: 'italic', color: theme.waiting }}>
            {strings.canvas.claimMarker}:{' '}
          </span>
        )}
        {text}
      </span>
      <button
        type="button"
        aria-label={strings.events.pointItOutAria(block.label)}
        onClick={() => onPoint(block.id)}
        style={{ background: 'none', color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
      >
        {strings.events.pointItOut}
      </button>
    </li>
  )
}

/** The list of lines. Events whose block the run does not contain are left out: a line must name a real block. */
export function EventBarList({ events, blocks, onPoint }: { events: readonly Wire[]; blocks: readonly Block[]; onPoint: (blockId: string) => void }) {
  const byId = new Map(blocks.map(b => [b.id, b]))
  const lines = events.flatMap(event => {
    if (!event.type.startsWith('node.')) return []
    const id = str(((event.payload ?? {}) as Record<string, unknown>).blockId)
    const block = id === undefined ? undefined : byId.get(id)
    return block ? [{ event, block }] : []
  })
  return (
    <section data-testid="event-bar" aria-label={strings.events.barTitle} style={{ borderTop: `1px solid ${theme.border}`, maxHeight: 180, overflowY: 'auto' }}>
      {lines.length === 0 ? (
        <p style={{ margin: 8, color: theme.skipped }}>{strings.events.empty}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
          {[...lines].reverse().map(({ event, block }) => ( // newest first, so the latest line is never scrolled away
            <EventBar key={event.sequence} event={event} block={block} onPoint={onPoint} />
          ))}
        </ul>
      )}
    </section>
  )
}

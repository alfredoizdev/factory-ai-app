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
  'node.question_asked': 'waiting_approval',
  'node.question_answered': 'running',
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
  if (event.type === 'node.question_asked') return { text: strings.question.cardWaiting, isClaim: false }
  if (event.type === 'node.question_answered') return { text: strings.question.answered, isClaim: false }
  if (event.type === 'node.reopened') {
    const round = typeof payload.round === 'number' ? payload.round : 2
    // Sent back by the reviewer: its problems are a model's claim, and are shown on the Review card as such.
    if (payload.by === 'reviewer') return { text: strings.events.reopenedByReviewer(round), isClaim: false }
    // Sent back after fixes: the app's own sentence, kept in the note.
    if (payload.by === 'fixes') return { text: str(payload.note) ?? strings.run.reopenedAfterFixes, isClaim: false }
    // The note is the person's own words, so it is shown as written: not a claim, not the app's sentence.
    // The round is the person's own count; events recorded before it was kept say the round they had.
    const asked = typeof payload.asked === 'number' ? payload.asked : round
    return { text: strings.events.reopened(asked, str(payload.note) ?? null), isClaim: false }
  }
  if (event.type === 'node.reviewed') {
    const n = Array.isArray(payload.findings) ? payload.findings.length : 0
    return { text: payload.verdict === 'ok' ? strings.review.noProblems : strings.review.problems(n), isClaim: true }
  }
  if (event.type === 'node.assessed') {
    const reasons = Array.isArray(payload.reasons) ? payload.reasons.filter((r): r is string => typeof r === 'string') : []
    return { text: strings.events.assessed(payload.level === 'low' ? 'low' : 'high', reasons), isClaim: false }
  }
  if (event.type === 'node.evidence') {
    // A measured fact: never a claim. Built from the numbers in the payload, the only part the event carries.
    const c = payload.counts as { passed?: unknown; failed?: unknown; total?: unknown } | null | undefined
    const counts =
      c && typeof c.passed === 'number' && typeof c.failed === 'number' && typeof c.total === 'number'
        ? strings.canvas.evidenceCounts(c.passed, c.failed, c.total)
        : null
    const exit = typeof payload.exitCode === 'number' ? payload.exitCode : null
    return { text: strings.events.measured(counts, exit), isClaim: false }
  }
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
  // A step or a measurement happens while the block runs.
  const state = EVENT_STATE[event.type] ?? 'running'
  const colour = theme[visualStateOf(state)]
  const { text, isClaim } = describeEvent(event, block)
  return (
    // Stacked to fit the sidebar: the block and the point-it-out control on one line, what happened under it.
    <li
      data-testid="event-line"
      style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', columnGap: 6, rowGap: 2, padding: '6px 8px', borderLeft: `3px solid ${colour}`, fontSize: 12.5 }}
    >
      <strong style={{ color: colour, fontSize: 11.5 }}>{block.label}</strong>
      <span style={{ gridColumn: '1 / -1', gridRow: 2, minWidth: 0, color: '#c9d1dc', lineHeight: 1.4, overflowWrap: 'anywhere' }}>
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
        title={strings.events.pointItOut}
        style={{ gridRow: 1, gridColumn: 2, background: 'none', color: theme.dim, border: `1px solid ${theme.border}`, borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '1px 6px' }}
      >
        ◎ {strings.events.pointItOut}
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
    <section data-testid="event-bar" aria-label={strings.events.barTitle}>
      {lines.length === 0 ? (
        <p style={{ margin: 0, color: theme.skipped, fontSize: 12.5 }}>{strings.events.empty}</p>
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

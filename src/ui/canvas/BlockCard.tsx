import { theme, type VisualState } from '@/ui/theme'
import { strings } from '@/ui/strings'
import type { Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'

export type NodeRunView = {
  blockId: string
  state: NodeState
  summary: string
  /** True when `summary` is a sentence an AI wrote rather than a verified fact. */
  summaryIsClaim: boolean
  steps: string[]
  /** Absent: no usage data for this node. Present with nulls: usage exists but was not reported. */
  usage?: { tokens: number | null; costCents: number | null }
}

/** What a card needs to render. Steps and provenance are optional here; absent means none / not a claim. */
export type CardView = Pick<NodeRunView, 'state' | 'summary' | 'usage'> &
  Partial<Pick<NodeRunView, 'steps' | 'summaryIsClaim'>>

// The domain and visual vocabularies are separate on purpose.
const VISUAL: Record<NodeState, VisualState> = {
  queued: 'skipped',
  running: 'running',
  waiting_approval: 'waiting',
  passed: 'passed',
  failed: 'failed',
  cancelled: 'skipped',
  skipped: 'skipped',
  // A blocked node needs attention, not a neutral tone.
  blocked: 'failed',
}

export function visualStateOf(state: NodeState): VisualState {
  return VISUAL[state]
}

// Only states that matter glow; quiet states get no shadow.
const GLOWING: ReadonlySet<VisualState> = new Set<VisualState>(['running', 'failed', 'waiting'])

export const CARD_WIDTH = 240

function formatCost(costCents: number): string {
  return `$${(costCents / 100).toFixed(2)}`
}

export function BlockCard({
  block,
  view,
  expanded = false,
  selected = false,
}: {
  block: Block
  view: CardView
  expanded?: boolean
  selected?: boolean
}) {
  const visual = visualStateOf(view.state)
  const stateLabel = strings.canvas.stateLabel[view.state]
  const steps = view.steps ?? []

  return (
    <div
      data-testid={`block-card-${block.id}`}
      style={{
        width: CARD_WIDTH,
        minWidth: 220,
        background: theme.card,
        border: `1px solid ${selected ? theme.running : theme.border}`,
        borderLeft: `4px solid ${theme[visual]}`,
        borderRadius: 8,
        padding: 12,
        boxShadow: GLOWING.has(visual) ? theme.glow(visual) : 'none',
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{block.label}</strong>
        <span
          aria-label={strings.canvas.stateAria(stateLabel)}
          style={{ color: theme[visual], fontSize: 12, fontWeight: 600 }}
        >
          {stateLabel}
        </span>
      </div>

      <p style={{ margin: '8px 0 0' }}>
        {view.summaryIsClaim === true && (
          <span title={strings.canvas.claimTitle} style={{ fontStyle: 'italic', color: theme.waiting }}>
            {strings.canvas.claimMarker}:{' '}
          </span>
        )}
        {view.summary}
      </p>

      {expanded && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
          {steps.length > 0 && (
            <>
              <div style={{ color: theme.skipped }}>{strings.canvas.steps}</div>
              <ul style={{ margin: '4px 0 8px', paddingLeft: 16 }}>
                {steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {view.usage && (
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
              <dt style={{ color: theme.skipped }}>{strings.canvas.tokens}</dt>
              <dd style={{ margin: 0 }}>
                {view.usage.tokens === null ? strings.canvas.notReported : view.usage.tokens.toLocaleString('en-US')}
              </dd>
              <dt style={{ color: theme.skipped }}>{strings.canvas.cost}</dt>
              <dd style={{ margin: 0 }}>
                {view.usage.costCents === null ? strings.canvas.notReported : formatCost(view.usage.costCents)}
              </dd>
            </dl>
          )}
        </div>
      )}
    </div>
  )
}

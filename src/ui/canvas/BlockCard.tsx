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

/** What a card needs to render. Provenance is required so it cannot be forgotten; steps are optional. */
export type CardView = Pick<NodeRunView, 'state' | 'summary' | 'summaryIsClaim' | 'usage'> &
  Partial<Pick<NodeRunView, 'steps'>>

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
/** The card grows in place; Canvas makes room for the difference with a transient layout offset. */
export const EXPANDED_CARD_WIDTH = 320
/** The step list is what the agent is doing now, not a log: only the latest few are shown. */
const MAX_STEPS = 6

function formatCost(costCents: number): string {
  return `$${(costCents / 100).toFixed(2)}`
}

export function BlockCard({
  block,
  view,
  expanded = false,
  selected = false,
  issues = [],
  breadcrumb,
  onCollapse,
}: {
  block: Block
  view: CardView
  expanded?: boolean
  selected?: boolean
  /** Validation messages for this block, shown on the card they belong to. */
  issues?: string[]
  /** Labels of the chain leading to this block; shown only while expanded. */
  breadcrumb?: string[]
  onCollapse?: () => void
}) {
  const visual = visualStateOf(view.state)
  const stateLabel = strings.canvas.stateLabel[view.state]
  const allSteps = view.steps ?? []
  const steps = allSteps.slice(-MAX_STEPS)
  const hiddenSteps = allSteps.length - steps.length
  const hasSummary = view.summary.trim() !== ''

  const frame = selected ? theme.running : theme.border

  return (
    <div
      data-testid={`block-card-${block.id}`}
      style={{
        width: expanded ? EXPANDED_CARD_WIDTH : CARD_WIDTH,
        minWidth: 220,
        background: theme.card,
        // Longhand only: a shorthand rewrite on selection would wipe the left bar that carries the state colour.
        borderStyle: 'solid',
        borderWidth: 1,
        // Per-side colours, not borderColor: that longhand would also repaint the left side when selection flips.
        borderTopColor: frame,
        borderRightColor: frame,
        borderBottomColor: frame,
        borderLeftWidth: 4,
        borderLeftColor: theme[visual],
        borderRadius: 8,
        padding: 12,
        boxShadow: GLOWING.has(visual) ? theme.glow(visual) : 'none',
        fontSize: 13,
        opacity: block.enabled ? 1 : 0.55,
      }}
    >
      {expanded && breadcrumb && breadcrumb.length > 0 && (
        <nav
          data-testid="breadcrumb"
          aria-label={strings.canvas.breadcrumbAria}
          style={{ color: theme.skipped, fontSize: 12, marginBottom: 6 }}
        >
          {breadcrumb.join(strings.canvas.breadcrumbSeparator)}
        </nav>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
        <strong style={{ fontSize: 14 }}>{block.label}</strong>
        {/* The model is written inside the block (design section 6): model-per-job is a selling point. */}
        {typeof block.config.model === 'string' && block.config.model.trim() !== '' && (
          <span data-testid={`block-model-${block.id}`} style={{ color: theme.skipped, fontSize: 12 }}>
            {block.config.model}
          </span>
        )}
        {!block.enabled && <span style={{ color: theme.skipped, fontSize: 12 }}>{strings.editing.disabledBadge}</span>}
        <span
          aria-label={strings.canvas.stateAria(stateLabel)}
          style={{ color: theme[visual], fontSize: 12, fontWeight: 600 }}
        >
          {stateLabel}
        </span>
        {expanded && onCollapse && (
          <button
            type="button"
            className="nodrag"
            onClick={e => {
              e.stopPropagation()
              onCollapse()
            }}
            style={{ background: 'none', color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
          >
            {strings.canvas.collapse}
          </button>
        )}
      </div>

      <p style={{ margin: '8px 0 0' }}>
        {block.enabled && hasSummary && view.summaryIsClaim && (
          <span title={strings.canvas.claimTitle} style={{ fontStyle: 'italic', color: theme.waiting }}>
            {strings.canvas.claimMarker}:{' '}
          </span>
        )}
        {!block.enabled ? strings.editing.disabledLine : hasSummary ? view.summary : strings.canvas.noResultLine}
      </p>

      {issues.map(message => (
        <p key={message} style={{ margin: '8px 0 0', color: theme.failed, fontWeight: 600 }}>
          {message}
        </p>
      ))}

      {expanded && (steps.length > 0 || view.usage) && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
          {steps.length > 0 && (
            <>
              <div style={{ color: theme.skipped }}>{strings.canvas.steps}</div>
              {hiddenSteps > 0 && (
                <div style={{ color: theme.skipped, fontSize: 12 }}>{strings.canvas.earlierStepsHidden(hiddenSteps)}</div>
              )}
              {/* start keeps the numbers true to the real position when earlier steps are not shown. */}
              <ol start={hiddenSteps + 1} style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
                {steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
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

/**
 * A block that is in the draft but not in the run being watched. It has no state at all (not even a quiet one):
 * the run never heard of it, so nothing here can come from the run. It stays selectable and removable.
 */
export function NotInRunCard({ block, selected = false, issues = [] }: { block: Block; selected?: boolean; issues?: string[] }) {
  return (
    <div
      data-testid={`block-card-${block.id}`}
      style={{
        width: CARD_WIDTH,
        minWidth: 220,
        background: 'transparent',
        border: `1px dashed ${selected ? theme.running : theme.skipped}`,
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
        opacity: block.enabled ? 0.8 : 0.55,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
        <strong style={{ fontSize: 14 }}>{block.label}</strong>
        {!block.enabled && <span style={{ color: theme.skipped, fontSize: 12 }}>{strings.editing.disabledBadge}</span>}
        <span style={{ color: theme.skipped, fontSize: 12, fontWeight: 600 }}>{strings.canvas.notInRun}</span>
      </div>
      <p style={{ margin: '8px 0 0', color: theme.skipped }}>{strings.canvas.notInRunDetail}</p>
      {issues.map(message => (
        <p key={message} style={{ margin: '8px 0 0', color: theme.failed, fontWeight: 600 }}>
          {message}
        </p>
      ))}
    </div>
  )
}

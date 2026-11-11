import { theme, type VisualState } from '@/ui/theme'
import { strings } from '@/ui/strings'
import type { Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'
import { TypeMark } from './TypeMark'

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

/** A finished block earns a corner mark. Only these two: a state still in motion has nothing to stamp. */
const CORNER_MARK: Partial<Record<NodeState, string>> = { passed: '✓', failed: '✕' }

export const CARD_WIDTH = 320
/** The card grows in place; Canvas makes room for the difference with a transient layout offset. */
export const EXPANDED_CARD_WIDTH = 400
/**
 * Every card is this tall whatever it holds, so a row of them reads as one row and a block that has
 * nothing to say yet does not shrink to a label. Quiet space is the point, not a gap to fill.
 */
export const CARD_MIN_HEIGHT = 304
/** A block far from the focus keeps a column this wide: enough for its mark, name, state and glyph. */
export const SPINE_WIDTH = 80
/** The step list is what the agent is doing now, not a log: only the latest few are shown. */
const MAX_STEPS = 6

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

function formatCost(costCents: number): string {
  return `$${(costCents / 100).toFixed(2)}`
}

/** The small all-caps label used for the state word and the section headings inside a card. */
const CAPS = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.13em',
  textTransform: 'uppercase',
} as const

export function BlockCard({
  block,
  view,
  expanded = false,
  selected = false,
  issues = [],
  breadcrumb,
  onCollapse,
  collapseLabel = strings.canvas.collapse,
  width,
}: {
  block: Block
  view: CardView
  expanded?: boolean
  selected?: boolean
  /** Overrides the width the expanded flag would choose; the fisheye keeps every panel the same width. */
  width?: number
  /** What the button that undoes the expansion says. */
  collapseLabel?: string
  /** Validation messages for this block, shown on the card they belong to. */
  issues?: string[]
  /** Labels of the chain leading to this block; shown only while expanded. */
  breadcrumb?: string[]
  onCollapse?: () => void
}) {
  const visual = visualStateOf(view.state)
  const accent = theme[visual]
  const stateLabel = strings.canvas.stateLabel[view.state]
  const allSteps = view.steps ?? []
  const steps = allSteps.slice(-MAX_STEPS)
  const hiddenSteps = allSteps.length - steps.length
  // A collapsed card has room for one line of what the block is doing, which beats leaving the space empty.
  const latestStep = allSteps[allSteps.length - 1]
  const hasSummary = view.summary.trim() !== ''
  // The claim treatment is structural, not a colour: a sentence an AI wrote gets its own tag and a quote
  // rule down its side, so it can never be mistaken for a measured fact at a glance.
  const isClaim = block.enabled && hasSummary && view.summaryIsClaim
  const corner = CORNER_MARK[view.state]

  const frame = selected ? theme.running : theme.border

  return (
    <div
      data-testid={`block-card-${block.id}`}
      style={{
        position: 'relative',
        width: width ?? (expanded ? EXPANDED_CARD_WIDTH : CARD_WIDTH),
        minWidth: 220,
        minHeight: CARD_MIN_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        background: theme.cardFace,
        // Longhand only: a shorthand rewrite on selection would wipe the left bar that carries the state colour.
        borderStyle: 'solid',
        borderWidth: 1,
        // Per-side colours, not borderColor: that longhand would also repaint the left side when selection flips.
        borderTopColor: frame,
        borderRightColor: frame,
        borderBottomColor: frame,
        borderLeftWidth: 4,
        borderLeftColor: accent,
        borderRadius: 14,
        padding: '15px 16px 13px',
        boxShadow: GLOWING.has(visual) ? theme.glow(visual) : 'none',
        fontSize: 13,
        opacity: block.enabled ? 1 : 0.55,
      }}
    >
      {/* A one-pixel catch-light along the top edge: the card reads as a panel with a lit edge, not a flat box. */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: 1,
          borderRadius: '14px 14px 0 0',
          background:
            'linear-gradient(90deg, transparent, rgba(255,255,255,0.09) 20%, rgba(255,255,255,0.09) 80%, transparent)',
        }}
      />
      {corner && (
        <span
          aria-hidden="true"
          data-testid={`corner-mark-${block.id}`}
          style={{
            position: 'absolute',
            right: -9,
            top: -9,
            width: 24,
            height: 24,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            background: accent,
            color: '#07090d',
            border: `2.5px solid ${theme.bg}`,
            fontSize: 12,
            fontWeight: 800,
            lineHeight: 1,
          }}
        >
          {corner}
        </span>
      )}

      {expanded && breadcrumb && breadcrumb.length > 0 && (
        <nav
          data-testid="breadcrumb"
          aria-label={strings.canvas.breadcrumbAria}
          style={{ color: theme.skipped, fontSize: 12, marginBottom: 8 }}
        >
          {breadcrumb.join(strings.canvas.breadcrumbSeparator)}
        </nav>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <TypeMark kind={block.kind} colour={accent} />
        <strong style={{ fontSize: 19, fontWeight: 620, letterSpacing: '-0.015em', lineHeight: 1.1 }}>
          {block.label}
        </strong>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* The model is written inside the block (design section 6): model-per-job is a selling point. */}
          {typeof block.config.model === 'string' && block.config.model.trim() !== '' && (
            <span
              data-testid={`block-model-${block.id}`}
              style={{
                padding: '4px 9px',
                background: 'rgba(255, 255, 255, 0.045)',
                border: `1px solid ${theme.lineSoft}`,
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 600,
                color: theme.dim,
                whiteSpace: 'nowrap',
              }}
            >
              {block.config.model}
            </span>
          )}
          {!block.enabled && <span style={{ color: theme.skipped, fontSize: 12 }}>{strings.editing.disabledBadge}</span>}
          {expanded && onCollapse && (
            <button
              type="button"
              className="nodrag"
              onClick={e => {
                e.stopPropagation()
                onCollapse()
              }}
              style={{
                background: 'none',
                color: 'inherit',
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 12,
                padding: '3px 8px',
              }}
            >
              {collapseLabel}
            </button>
          )}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '11px 0 0' }}>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: accent, flex: '0 0 auto' }} />
        <span aria-label={strings.canvas.stateAria(stateLabel)} style={{ ...CAPS, fontSize: 11, color: accent }}>
          {stateLabel}
        </span>
      </div>

      {isClaim && (
        <div title={strings.canvas.claimTitle} style={{ ...CAPS, color: theme.waiting, margin: '11px 0 3px' }}>
          {strings.canvas.claimMarker}
        </div>
      )}
      <p
        style={{
          margin: isClaim ? 0 : '9px 0 0',
          fontSize: isClaim ? 15 : 16,
          lineHeight: 1.36,
          letterSpacing: '-0.005em',
          color: isClaim ? '#e7dcc4' : theme.ink,
          fontStyle: isClaim ? 'italic' : 'normal',
          borderLeft: isClaim ? `2px solid ${theme.tint('waiting', 0.5)}` : undefined,
          paddingLeft: isClaim ? 10 : undefined,
        }}
      >
        {!block.enabled ? strings.editing.disabledLine : hasSummary ? view.summary : strings.canvas.noResultLine}
      </p>

      {issues.map(message => (
        <p
          key={message}
          style={{
            margin: '10px 0 0',
            fontSize: 12.5,
            color: '#ffb4ac',
            background: theme.tint('failed', 0.09),
            border: `1px solid ${theme.tint('failed', 0.28)}`,
            borderRadius: 8,
            padding: '7px 9px',
          }}
        >
          {message}
        </p>
      ))}

      {expanded && steps.length > 0 && (
        <div style={{ marginTop: 13 }}>
          <div style={{ ...CAPS, color: '#7d8798', marginBottom: 7 }}>{strings.canvas.steps}</div>
          {hiddenSteps > 0 && (
            <div style={{ color: theme.skipped, fontSize: 11.5, marginBottom: 4 }}>
              {strings.canvas.earlierStepsHidden(hiddenSteps)}
            </div>
          )}
          {/* start keeps the numbers true to the real position when earlier steps are not shown. */}
          <ol start={hiddenSteps + 1} style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 3, fontSize: 12.5 }}>
            {steps.map((s, i) => (
              // The newest step is the one happening now, so it is the only one at full strength.
              <li key={i} style={{ color: i === steps.length - 1 ? '#dfe4ec' : '#6a7383' }}>
                {s}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div style={{ marginTop: 'auto' }}>
        {!expanded && latestStep !== undefined && (
          <div
            style={{
              display: 'flex',
              gap: 7,
              alignItems: 'baseline',
              paddingTop: 12,
              borderTop: `1px solid ${theme.lineSoft}`,
              fontSize: 12.5,
              color: view.state === 'running' ? '#dfe4ec' : '#6a7383',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                marginTop: 6,
                flex: '0 0 auto',
                background: view.state === 'running' ? theme.running : '#39424f',
                boxShadow: view.state === 'running' ? `0 0 7px ${theme.running}` : 'none',
              }}
            />
            {latestStep}
          </div>
        )}
        {view.usage && (
          <dl
            style={{
              margin: 0,
              paddingTop: 12,
              borderTop: `1px solid ${theme.lineSoft}`,
              display: 'flex',
              alignItems: 'baseline',
              gap: '0 8px',
              fontFamily: MONO,
              fontSize: 11.5,
              color: '#7d8798',
            }}
          >
            <dt>{strings.canvas.tokens}</dt>
            <dd style={{ margin: 0, color: theme.dim, fontWeight: 600 }}>
              {view.usage.tokens === null ? strings.canvas.notReported : view.usage.tokens.toLocaleString('en-US')}
            </dd>
            <dt style={{ marginLeft: 'auto' }}>{strings.canvas.cost}</dt>
            <dd style={{ margin: 0, color: theme.dim, fontWeight: 600 }}>
              {view.usage.costCents === null ? strings.canvas.notReported : formatCost(view.usage.costCents)}
            </dd>
          </dl>
        )}
      </div>
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
        minHeight: CARD_MIN_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 10,
        background: 'transparent',
        border: `1px dashed ${selected ? theme.running : theme.skipped}`,
        borderRadius: 14,
        padding: '15px 16px',
        fontSize: 13,
        opacity: block.enabled ? 0.8 : 0.55,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <TypeMark kind={block.kind} colour={theme.skipped} />
        <strong style={{ fontSize: 19, fontWeight: 620, letterSpacing: '-0.015em', color: '#8b95a8' }}>
          {block.label}
        </strong>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {!block.enabled && <span style={{ color: theme.skipped, fontSize: 12 }}>{strings.editing.disabledBadge}</span>}
          <span style={{ ...CAPS, fontSize: 10, color: theme.skipped }}>{strings.canvas.notInRun}</span>
        </span>
      </div>
      <p style={{ margin: 0, color: theme.skipped, fontSize: 14, lineHeight: 1.36 }}>{strings.canvas.notInRunDetail}</p>
      {issues.map(message => (
        <p
          key={message}
          style={{
            margin: 0,
            fontSize: 12.5,
            color: '#ffb4ac',
            background: theme.tint('failed', 0.09),
            border: `1px solid ${theme.tint('failed', 0.28)}`,
            borderRadius: 8,
            padding: '7px 9px',
          }}
        >
          {message}
        </p>
      ))}
    </div>
  )
}

/** What a spine shows instead of the state word, so a collapsed block never reads by colour alone. */
const SPINE_GLYPH: Record<NodeState, string> = {
  queued: '·',
  running: '▸',
  waiting_approval: '!',
  passed: '✓',
  failed: '✕',
  cancelled: '·',
  skipped: '·',
  blocked: '!',
}

/**
 * A block far from the focus, compressed to a column. It keeps everything needed to find it again — its
 * drawing, its name, its state colour and a glyph for that state — and drops everything that needs width.
 * Clicking it makes it the focus, which is how its detail comes back.
 */
export function SpineCard({ block, view, selected = false }: { block: Block; view: CardView | null; selected?: boolean }) {
  const visual = view ? visualStateOf(view.state) : 'skipped'
  const accent = theme[visual]
  const stateLabel = view ? strings.canvas.stateLabel[view.state] : strings.canvas.notInRun
  return (
    <div
      data-testid={`block-card-${block.id}`}
      title={`${block.label} — ${stateLabel}`}
      style={{
        position: 'relative',
        width: SPINE_WIDTH,
        minHeight: CARD_MIN_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '14px 0 16px',
        background: 'linear-gradient(180deg, #141a24, #10151d)',
        borderStyle: 'solid',
        borderWidth: 1,
        borderTopWidth: 3,
        borderTopColor: accent,
        borderRightColor: selected ? theme.running : theme.border,
        borderBottomColor: selected ? theme.running : theme.border,
        borderLeftColor: selected ? theme.running : theme.border,
        borderRadius: 12,
        cursor: 'pointer',
        opacity: block.enabled ? 1 : 0.55,
      }}
    >
      <TypeMark kind={block.kind} colour={accent} size={26} />
      <span style={{ writingMode: 'vertical-rl', fontSize: 13, fontWeight: 600, letterSpacing: '0.02em', color: '#aeb7c6' }}>
        {block.label}
      </span>
      <span
        aria-label={strings.canvas.stateAria(stateLabel)}
        style={{
          marginTop: 'auto',
          width: 22,
          height: 22,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          background: view ? accent : 'transparent',
          border: view ? 'none' : `1px dashed ${theme.skipped}`,
          color: view ? '#07090d' : theme.skipped,
          fontSize: 11,
          fontWeight: 800,
          lineHeight: 1,
        }}
      >
        {view ? SPINE_GLYPH[view.state] : '·'}
      </span>
    </div>
  )
}

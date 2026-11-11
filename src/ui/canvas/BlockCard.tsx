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
  /** What a non-model process measured (a test run). Absent: nothing was measured for this block. */
  evidence?: RunEvidence
  /** The measured risk of the run's change, on the human check. Absent: not measured (a demo run). */
  risk?: { level: 'low' | 'high'; reasons: string[] }
  /** Which round of the run this block is on, from the second on: the person asked for changes. */
  round?: number
}

export type RunEvidence = {
  counts: { passed: number; failed: number; total: number } | null
  /** Null when the process did not exit on its own. */
  exitCode: number | null
  /** The signal that killed it, when that is how it ended. */
  signal?: string | null
  durationMs: number
  /**
   * Test files or test configuration this run changed (up to a screenful), and how many in all. A non-empty list means
   * the agent touched what judges it, so the result is shown with that said. Null: it could not be checked.
   */
  changedTestFiles?: string[] | null
  changedTestFilesCount?: number | null
}

/** What a card needs to render. Provenance is required so it cannot be forgotten; steps are optional. */
export type CardView = Pick<NodeRunView, 'state' | 'summary' | 'summaryIsClaim' | 'usage'> &
  Partial<Pick<NodeRunView, 'steps' | 'evidence' | 'risk' | 'round'>>

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
  onRemove,
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
  /** Present when this block can be taken out of the flow from its card. */
  onRemove?: () => void
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
      {view.state === 'running' && (
        <span style={{ position: 'absolute', right: 12, top: 14 }}>
          <WorkingSpinner blockId={block.id} />
        </span>
      )}
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
          {/* A Tests block's own command, so two Tests cards are told apart by what they check. */}
          {block.kind === 'tests' && typeof block.config.testCommand === 'string' && block.config.testCommand.trim() !== '' && (
            <span
              data-testid={`block-command-${block.id}`}
              title={block.config.testCommand}
              style={{
                maxWidth: 150,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                padding: '4px 9px',
                background: 'rgba(255, 255, 255, 0.045)',
                border: `1px solid ${theme.lineSoft}`,
                borderRadius: 999,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11,
                color: theme.dim,
                whiteSpace: 'nowrap',
              }}
            >
              {block.config.testCommand.trim()}
            </span>
          )}
          {!block.enabled && <span style={{ color: theme.skipped, fontSize: 12 }}>{strings.editing.disabledBadge}</span>}
          {onRemove && <RemoveButton label={block.label} onRemove={onRemove} />}
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
        {view.round && (
          <span
            data-testid={`round-${block.id}`}
            style={{ ...CAPS, fontSize: 9.5, color: '#cfe0ff', padding: '2px 7px', borderRadius: 999, border: `1px solid ${theme.tint('running', 0.45)}`, marginLeft: 4 }}
          >
            {strings.gate.round(view.round)}
          </span>
        )}
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

      {view.evidence && <EvidenceStrip evidence={view.evidence} />}
      {view.risk && <RiskStrip risk={view.risk} />}

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
export function NotInRunCard({
  block,
  selected = false,
  issues = [],
  onRemove,
}: {
  block: Block
  selected?: boolean
  issues?: string[]
  onRemove?: () => void
}) {
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
          {onRemove && <RemoveButton label={block.label} onRemove={onRemove} />}
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
      {view?.state === 'running' && <WorkingSpinner blockId={block.id} size={18} />}
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

/** Above this many tests, one pip each stops being countable at a glance, so the strip shows a bar instead. */
const MAX_PIPS = 30

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * Only what a process measured: the counts it printed, its exit code, how long it took. Nothing a model said can
 * reach this strip — it is drawn from evidence records alone, which is what makes it worth trusting.
 */
export function EvidenceStrip({ evidence }: { evidence: RunEvidence }) {
  const c = evidence.counts
  const touched = evidence.changedTestFiles ?? []
  const touchedCount = evidence.changedTestFilesCount ?? touched.length
  // The check mark says "this was measured and nothing undercuts it". A run that changed its own tests loses it.
  const clean = touchedCount === 0 && evidence.changedTestFiles !== null
  return (
    <div
      data-testid="evidence-strip"
      style={{
        marginTop: 12,
        background: 'rgba(124, 160, 255, 0.045)',
        border: `1px solid ${theme.lineSoft}`,
        borderRadius: 10,
        padding: '9px 11px 10px',
      }}
    >
      <div style={{ ...CAPS, fontSize: 9.5, letterSpacing: '0.14em', color: '#7d8798', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span aria-hidden="true" style={{ color: clean ? theme.passed : theme.waiting }}>{clean ? '✓' : '!'}</span>
        {strings.canvas.evidence}
      </div>
      {touchedCount > 0 && (
        <div data-testid="tests-changed" role="note" style={{ fontSize: 12, color: theme.waiting, margin: '0 0 8px', lineHeight: 1.4 }}>
          {strings.canvas.testsChanged(touchedCount)}{' '}
          <span style={{ fontFamily: MONO, fontSize: 11.5, color: '#e7dcc4' }}>
            {touched.slice(0, 3).join(', ')}
            {touchedCount > 3 ? ` ${strings.canvas.andMore(touchedCount - 3)}` : ''}
          </span>
        </div>
      )}
      {evidence.changedTestFiles === null && (
        <div data-testid="tests-unchecked" style={{ fontSize: 12, color: theme.skipped, margin: '0 0 8px' }}>
          {strings.canvas.testsUnchecked}
        </div>
      )}
      {c && c.total > 0 && (
        <div
          role="img"
          aria-label={strings.canvas.evidenceCounts(c.passed, c.failed, c.total)}
          style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 8 }}
        >
          {c.total <= MAX_PIPS ? (
            Array.from({ length: c.total }, (_, i) => (
              <span
                key={i}
                data-pip={i < c.passed ? 'passed' : i < c.passed + c.failed ? 'failed' : 'other'}
                style={{
                  width: 7,
                  height: 13,
                  borderRadius: 2,
                  flex: '0 0 auto',
                  background: i < c.passed ? theme.passed : i < c.passed + c.failed ? theme.failed : '#30394a',
                }}
              />
            ))
          ) : (
            <span style={{ display: 'flex', flex: 1, height: 8, borderRadius: 4, overflow: 'hidden', background: '#30394a' }}>
              <span style={{ width: `${(c.passed / c.total) * 100}%`, background: theme.passed }} />
              <span style={{ width: `${(c.failed / c.total) * 100}%`, background: theme.failed }} />
            </span>
          )}
          <span style={{ fontFamily: MONO, fontSize: 11.5, color: theme.dim, marginLeft: 7, fontWeight: 600 }}>
            {strings.canvas.evidenceCounts(c.passed, c.failed, c.total)}
          </span>
        </div>
      )}
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px', margin: 0, fontFamily: MONO, fontSize: 11.5, color: theme.dim }}>
        <span>
          <dt style={{ display: 'inline' }}>{strings.canvas.exitCode} </dt>
          <dd style={{ display: 'inline', margin: 0, color: evidence.exitCode === 0 ? theme.passed : theme.failed, fontWeight: 600 }}>
            {evidence.exitCode !== null ? evidence.exitCode : evidence.signal ? evidence.signal : strings.canvas.notReported}
          </dd>
        </span>
        <span>
          <dt style={{ display: 'inline' }}>{strings.canvas.took} </dt>
          <dd style={{ display: 'inline', margin: 0, color: '#d6dce6', fontWeight: 600 }}>{formatDuration(evidence.durationMs)}</dd>
        </span>
      </dl>
    </div>
  )
}

/**
 * A ring that turns while a block is running. Decorative: the state word beside it already says "Running", so it is
 * hidden from assistive tech. It exists only while the state is running, so it can never outlive the work.
 */
export function WorkingSpinner({ blockId, size = 20 }: { blockId: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      data-testid={`spinner-${blockId}`}
      className="factory-spinner"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      style={{ display: 'block' }}
    >
      <circle cx="10" cy="10" r="8" fill="none" stroke={theme.tint('running', 0.25)} strokeWidth="2.5" />
      <path d="M10 2a8 8 0 0 1 8 8" fill="none" stroke={theme.running} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * What was measured about the change before the human check: low risk (and why), or what needs the person. Built
 * from the diff and the test records by the app, never from the agent, so it is drawn like evidence, not a claim.
 */
export function RiskStrip({ risk }: { risk: { level: 'low' | 'high'; reasons: string[] } }) {
  const low = risk.level === 'low'
  const tone = low ? theme.passed : theme.waiting
  return (
    <div
      data-testid="risk-strip"
      data-level={risk.level}
      style={{ marginTop: 12, background: theme.tint(low ? 'passed' : 'waiting', 0.06), border: `1px solid ${theme.tint(low ? 'passed' : 'waiting', 0.3)}`, borderRadius: 10, padding: '9px 11px 10px' }}
    >
      <div style={{ ...CAPS, fontSize: 9.5, letterSpacing: '0.14em', color: tone, marginBottom: 6 }}>{strings.risk.label[risk.level]}</div>
      <ul style={{ margin: 0, paddingLeft: 16, display: 'grid', gap: 3, fontSize: 12.5, color: '#d6dce6', lineHeight: 1.4 }}>
        {risk.reasons.slice(0, 4).map(r => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {risk.reasons.length > 4 && <div style={{ fontSize: 12, color: theme.dim, marginTop: 4 }}>{strings.canvas.andMore(risk.reasons.length - 4)}</div>}
    </div>
  )
}

/** A small bin on the card: takes the block out of the flow. Saved like any other edit, and undone by adding it again. */
export function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      className="nodrag"
      aria-label={strings.editing.removeNamed(label)}
      title={strings.editing.removeNamed(label)}
      onClick={e => {
        e.stopPropagation()
        onRemove()
      }}
      style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, padding: 0, background: 'none', border: `1px solid ${theme.border}`, borderRadius: 6, color: theme.dim, cursor: 'pointer' }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" />
      </svg>
    </button>
  )
}

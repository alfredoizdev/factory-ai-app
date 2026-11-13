'use client'

import { Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance, ViewportPortal } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { derivedEdges, STAGE_ORDER, type Block, type Graph, type ValidationIssue } from '@/domain/graph'
import { summarize } from '@/domain/summary'
import { BlockInspector } from './BlockInspector'
import { addBlock, addableKinds, canDisable, canRemove, chainTo, moveBlock, removeBlock, updateBlock } from './editing'
import type { NodeState } from '@/domain/states'
import { brand } from '@/ui/brand'
import { theme } from '@/ui/theme'
import { Logo } from '@/ui/Logo'
import { strings } from '@/ui/strings'
import { Depth } from './Depth'
import { StepsLane, stepToShow } from './StepsView'
import { ParticleLayer, type Cable } from './FlowParticles'
import { useReducedMotion } from './useReducedMotion'
import { COMMAND_CARD_WIDTH } from './layout'
import { BlockCard, CARD_WIDTH, EXPANDED_CARD_WIDTH, NotInRunCard, SPINE_WIDTH, SpineCard, type NodeRunView } from './BlockCard'
import { autoFocus, fisheyeLayout, laneViewport, type Placement } from './fisheye'
import { SidebarIcon, type SidebarIconName } from './SidebarIcons'
import { usePersistentFlag } from './usePersistentFlag'
import { LaneSkeleton } from './Skeleton'

export type { NodeRunView }

const RETURN_OUT = 'return-out'
const RETURN_IN = 'return-in'

type CardData = {
  block: Block
  /** Absent: the run does not contain this block, so there is no state to show. */
  view: NodeRunView | null
  highlighted: boolean
  expanded: boolean
  selected: boolean
  issues: string[]
  breadcrumb: string[]
  /** True when the fisheye has pushed this block away from the focus, so it is drawn as a spine. */
  collapsed: boolean
  /** Set while the fisheye is laying out, so every panel in the lane is the same width. */
  cardWidth?: number
  collapseLabel?: string
  onCollapse?: () => void
  /** Present on a card that can be taken out of the flow from the card itself. */
  onRemove?: () => void
  failedActions?: { onSee: () => void; onAgain?: () => void }
  onDetails?: () => void
}
type CardNode = Node<CardData, 'block'>

function BlockNode({ data }: NodeProps<CardNode>) {
  const reduced = useReducedMotion()
  const [hovered, setHovered] = useState(false)
  const lifted = hovered && !reduced
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid={`node-${data.block.id}`}
      data-state={data.view ? data.view.state : 'not_in_run'}
      data-highlighted={data.highlighted ? 'true' : 'false'}
      style={{
        borderRadius: 10,
        outline: data.highlighted ? `3px solid ${theme.pointer}` : 'none',
        outlineOffset: 3,
        // Hover deepens the card's shadow. The card itself never moves: its buttons and text stay where they are.
        boxShadow: theme.elevation(lifted ? 2 : 0),
        transition: reduced ? 'none' : 'box-shadow 120ms ease-out',
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {/* Under the fisheye a block opens and closes as the work moves along. Its frame grows or shrinks to the new
          width while the new face fades in, so a card never snaps shut. Off the fisheye, or under reduced motion, it
          is drawn directly. */}
      <div
        style={
          data.cardWidth !== undefined && !reduced
            ? {
                // A margin of room around the card inside the clip, so the corner mark that sits over its edge shows.
                width: (data.collapsed ? SPINE_WIDTH : data.cardWidth) + 2 * CLIP_ROOM,
                padding: CLIP_ROOM,
                margin: -CLIP_ROOM,
                overflow: 'hidden',
                transition: 'width 320ms cubic-bezier(0.2, 0.7, 0.2, 1)',
              }
            : undefined
        }
      >
      <div key={data.collapsed ? 'spine' : 'card'} className={data.cardWidth !== undefined && !reduced ? 'factory-fade-in' : undefined}>
      {data.collapsed ? (
        <SpineCard block={data.block} view={data.view} selected={data.selected} />
      ) : data.view ? (
        <BlockCard
          block={data.block}
          view={data.view}
          expanded={data.expanded}
          selected={data.selected}
          issues={data.issues}
          breadcrumb={data.breadcrumb}
          onCollapse={data.onCollapse}
          collapseLabel={data.collapseLabel}
          onRemove={data.onRemove}
          width={data.cardWidth}
          failedActions={data.failedActions}
          onDetails={data.onDetails}
        />
      ) : (
        <NotInRunCard block={data.block} selected={data.selected} issues={data.issues} onRemove={data.onRemove} />
      )}
      </div>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {/* Bottom handles carry the return cable so it loops beneath the lane. */}
      {/* On top: the way back runs above the lane, clear of the check blocks stacked below it. */}
      <Handle id={RETURN_OUT} type="source" position={Position.Top} isConnectable={false} />
      <Handle id={RETURN_IN} type="target" position={Position.Top} isConnectable={false} />
    </div>
  )
}

/** Room around a card inside its resizing frame: the corner mark overhangs the card by 9px. */
const CLIP_ROOM = 14

// One way of fitting the lane, used on load and on every refit, so a reload lands where the view already was. The
// right side keeps room for the command card (its width plus its 16px margin and some air), so no block is under it.
const PAD = { top: 48, bottom: 48, left: 40, right: COMMAND_CARD_WIDTH + 56 }
const FIT = {
  maxZoom: 1,
  padding: { top: `${PAD.top}px`, bottom: `${PAD.bottom}px`, left: `${PAD.left}px`, right: `${PAD.right}px` },
} as const

const nodeTypes = { block: BlockNode }

const SIDEBAR_WIDTH = 300
const RAIL_WIDTH = 56
const SIDEBAR_KEY = 'factory.sidebar.open'
const RUN_SECTION = 'sidebar-run'
const PALETTE_SECTION = 'sidebar-palette'
const SETTINGS_SECTION = 'sidebar-block-settings'
const LOG_SECTION = 'sidebar-log'
const LOG_MAX_HEIGHT = 380
/** The id the run panel gives its request box, so the rail's run icon can put the cursor in it. */
export const RUN_INPUT_ID = 'run-request'

/** An icon-only button. Its name is the label (read aloud and shown on hover), so the icon never stands alone. */
function RailButton({ icon, label, onClick }: { icon: SidebarIconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        display: 'grid',
        placeItems: 'center',
        background: 'transparent',
        color: theme.dim,
        border: `1px solid transparent`,
        borderRadius: 8,
        cursor: 'pointer',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = theme.card
        e.currentTarget.style.borderColor = theme.border
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.borderColor = 'transparent'
      }}
    >
      <SidebarIcon name={icon} />
    </button>
  )
}

/** The floor trails the pan at this fraction, which is what reads as depth. */
const PARALLAX = 0.3

const SAVE_DELAY_MS = 500

const panelButton = {
  padding: '6px 10px',
  background: theme.card,
  color: 'inherit',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  cursor: 'pointer',
  textAlign: 'left' as const,
}

/** The parts of a block the run owns. Absent: the run does not hold the block, so the draft's stand. */
function pick(frozen: Block | undefined): Partial<Block> {
  return frozen ? { label: frozen.label, enabled: frozen.enabled, config: frozen.config } : {}
}

/** With no run at all, every block has honestly not started, so it is queued. */
function queuedView(block: Block): NodeRunView {
  return {
    blockId: block.id,
    state: 'queued',
    summary: summarize({ kind: block.kind, state: 'queued' }),
    summaryIsClaim: false,
    steps: [],
  }
}

/**
 * How far to push a block sideways to make room for the expanded card. This is a drawing offset only:
 * it is applied when building nodes and removed again before a position is stored.
 */
function expansionOffsetX(graph: Graph, expandedId: string | null, block: Block): number {
  const expanded = graph.blocks.find(b => b.id === expandedId)
  if (!expanded || block.id === expanded.id || block.position.x <= expanded.position.x) return 0
  return EXPANDED_CARD_WIDTH - CARD_WIDTH
}

export function Canvas({
  graph: initialGraph,
  nodeRuns = [],
  save,
  expandedId: initialExpandedId = null,
  runBlocks,
  highlightedId = null,
  flushRef,
  sidebarTop,
  sidebarLog,
  loading = false,
  blank = false,
  taskId = null,
  overlay,
  onFailedClick,
  onDetails,
  canRetry = false,
  layout = 'canvas',
  stepDetails,
}: {
  /** 'steps': the flow is drawn as one row of steps with the picked step's details under it, instead of as a canvas. */
  layout?: 'canvas' | 'steps'
  /** In the steps layout: the details of one block of the run on screen. */
  stepDetails?: (blockId: string) => ReactNode
  /** Asked from a block that failed: to see what went wrong, or to try again. */
  onFailedClick?: (what: 'see' | 'again') => void
  /** While a run is on screen: opens the details of one of its blocks. */
  onDetails?: (blockId: string) => void
  /** True when the failed run's work can be picked up again: the block then offers Try again. */
  canRetry?: boolean
  /** Drawn over the flow, inside its own area (never under the sidebar): the open task's title. */
  overlay?: ReactNode
  /** A task is still loading: placeholders stand where its cards will be, and the cards appear once it is whole. */
  loading?: boolean
  /** The task on screen. When it changes, a card opened by hand on the last one is let go. */
  taskId?: string | null
  /** Nothing is open and nothing is being started: the flow is not drawn, so the screen can say what to do. */
  blank?: boolean
  graph: Graph
  nodeRuns?: NodeRunView[]
  /** Persists the draft and returns what is wrong with it. Absent: edits stay on screen only. */
  save?: (graph: Graph) => Promise<ValidationIssue[]>
  /** The block that starts out expanded. */
  expandedId?: string | null
  /**
   * The blocks of the run being watched (its frozen version). A draft block is part of the run only if the run
   * holds a block with the same id and kind. Absent: membership is whatever `nodeRuns` has a view for.
   */
  runBlocks?: readonly Block[]
  /** The block an event line pointed at. */
  highlightedId?: string | null
  /** Filled with a function that saves any pending edit now and says whether the draft is safely on the server. */
  flushRef?: { current: (() => Promise<boolean>) | null }
  /** The first section of the sidebar: the agent's settings. Absent: the sidebar holds only the editing tools. */
  sidebarTop?: ReactNode
  /** The run's log, at the foot of the sidebar. Absent: there is no run to log. */
  sidebarLog?: ReactNode
}) {
  const [graph, setGraph] = useState(initialGraph)
  const [selectedId, setSelectedId] = useState<string | null>(initialExpandedId)
  // Expansion is a view state only: it never enters the graph and so is never saved.
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  // Null means the canvas follows the work by itself; a value means a person chose a block and it stays open.
  const [focusOverride, setFocusOverride] = useState<string | null>(null)
  // Another task came on screen: the card the person had opened belonged to the last one, so the lane goes back to
  // following the work. Done while rendering, so the new task is never drawn once with the old card open.
  const [shownTask, setShownTask] = useState(taskId)
  if (shownTask !== taskId) {
    setShownTask(taskId)
    setFocusOverride(null)
    setSelectedId(null)
  }
  // Pointing at a block from the event bar is a request to see it, so it also becomes the focus. This is the
  // adjust-state-while-rendering pattern, deliberately: doing it from an effect would render the lane twice.
  const [pointedAt, setPointedAt] = useState(highlightedId)
  if (highlightedId !== pointedAt) {
    setPointedAt(highlightedId)
    if (highlightedId) setFocusOverride(highlightedId)
  }
  const [saveFailed, setSaveFailed] = useState(false)

  const graphRef = useRef(initialGraph)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const mounted = useRef(false)
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  const inflight = useRef<Promise<void>>(Promise.resolve())
  const flushNow = useCallback((): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const persist = saveRef.current
    if (!dirty.current || !persist) return inflight.current
    dirty.current = false
    const mine = ++seq.current
    // Only the newest response may touch the screen; an older one is stale.
    inflight.current = persist(graphRef.current).then(
      result => {
        if (!mounted.current || mine !== seq.current) return
        setIssues(result)
        setSaveFailed(false)
      },
      () => {
        // The edit never reached the server: keep it pending so an unmount flush or the next edit retries it.
        dirty.current = true
        if (mounted.current && mine === seq.current) setSaveFailed(true)
      },
    )
    return inflight.current
  }, [])
  const flush = useCallback(() => void flushNow(), [flushNow])
  useEffect(() => {
    if (!flushRef) return
    flushRef.current = async () => {
      await flushNow()
      return !dirty.current
    }
    return () => {
      flushRef.current = null
    }
  }, [flushRef, flushNow])

  // A pending save must survive leaving the page or unmounting.
  useEffect(() => {
    mounted.current = true
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
      mounted.current = false
    }
  }, [flush])

  const edit = useCallback(
    (change: (g: Graph) => Graph, persist = true) => {
      graphRef.current = change(graphRef.current)
      setGraph(graphRef.current)
      if (!persist) return
      dirty.current = true
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, SAVE_DELAY_MS)
    },
    [flush],
  )

  const runById = new Map(nodeRuns.map(r => [r.blockId, r]))
  const issuesFor = (id: string) => issues.filter(i => i.blockId === id).map(i => i.message)
  const unattributed = issues.filter(i => i.blockId === null || !graph.blocks.some(b => b.id === i.blockId))
  const addable = addableKinds(graph)
  const flow = useRef<ReactFlowInstance<CardNode> | null>(null)
  // Each card's size as the flow last measured it.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})
  const reducedMotion = useReducedMotion()
  const [sidebarOpen, setSidebarOpen] = usePersistentFlag(SIDEBAR_KEY, true)
  // While a run is on screen the camera is placed from the layout itself (laneViewport), the same on every load; while
  // editing, the flow's own fit is used. Either way the command card's corner is left free.
  const pane = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<ReadonlyMap<string, Placement> | null>(null)
  const fitLane = useCallback((duration: number) => {
    const instance = flow.current
    const el = pane.current
    if (!instance) return
    const lane = layoutRef.current
    if (lane && el) void instance.setViewport(laneViewport(lane, { width: el.clientWidth, height: el.clientHeight }, PAD), { duration })
    else void instance.fitView({ ...FIT, duration })
  }, [])
  useEffect(() => {
    const onResize = () => fitLane(0)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fitLane])

  // The canvas gets wider or narrower when the sidebar moves, so the lane is fitted again rather than left off-centre.
  useEffect(() => {
    // Two frames: the first lays out the new width, the second lets the flow measure it before fitting to it.
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => fitLane(reducedMotion ? 0 : 300))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [sidebarOpen, reducedMotion, fitLane])
  // From the rail: open the sidebar at one section, and put the cursor where typing belongs.
  const openAt = (sectionId: string, focusId?: string) => {
    setSidebarOpen(true)
    requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView?.({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' })
      if (focusId) document.getElementById(focusId)?.focus()
    })
  }
  const floorRef = useRef<HTMLDivElement | null>(null)
  // Moved straight on the DOM node: a pan fires every frame and must not re-render the canvas.
  const parallax = useCallback((vp: { x: number; y: number }) => {
    if (floorRef.current) floorRef.current.style.translate = `${vp.x * PARALLAX}px ${vp.y * PARALLAX}px`
  }, [])
  useEffect(() => {
    if (highlightedId) void flow.current?.fitView({ ...FIT, nodes: [{ id: highlightedId }], duration: 300 })
  }, [highlightedId])

  // The queued default is only true when there is no run. Once a run exists, a block it has no view for is
  // not part of that run, so it is not drawn rather than shown with an invented state.
  const hasRun = runBlocks !== undefined || nodeRuns.length > 0
  const reservedIds = runBlocks?.map(b => b.id) ?? []
  // Same id AND same kind: a reused id for a different kind must not borrow the old block's view. (The palette
  // also never hands out an id the run holds, so a reused id of the same kind cannot arise from adding.)
  const inRun = (block: Block) =>
    runBlocks ? runBlocks.some(b => b.id === block.id && b.kind === block.kind) : runById.has(block.id)
  // While a run is watched, what a block IS (name, whether it ran, its model) comes from the run's frozen block;
  // the draft only supplies where it sits and what can be edited. A block the draft has since removed is still drawn,
  // from the run, so every line in the event bar points at a card that exists.
  const frozenOf = (block: Block): Block | undefined => runBlocks?.find(b => b.id === block.id && b.kind === block.kind)
  const draftIds = new Set(graph.blocks.map(b => b.id))
  const removedFromDraft = (runBlocks ?? []).filter(b => !draftIds.has(b.id))
  const presented: Graph = { blocks: [...graph.blocks.map(b => ({ ...b, ...pick(frozenOf(b)) })), ...removedFromDraft] }

  // While a run is on screen the canvas lays the lane out itself, around whatever is happening: the focus and
  // its two neighbours stay full panels and the rest collapse, so every block fits without anything hiding.
  // Dragging is off meanwhile, because a card cannot both be placed by hand and move on its own.
  const ordered = STAGE_ORDER.flatMap(kind => presented.blocks.filter(b => b.kind === kind))
  const focusId = hasRun
    ? (focusOverride ?? autoFocus(ordered.map(b => ({ id: b.id, state: runById.get(b.id)?.state ?? null }))))
    : null
  // Some blocks never collapse. Two because a spine has nowhere to say what is wrong with them: one carrying a
  // validation message, and one the run does not contain at all. And the block where the work is right now
  // (running, or waiting for the person) stays open even while another card is being read, so it is always
  // plain where the task stands.
  const activeNow = (id: string) => {
    const state = runById.get(id)?.state
    return state === 'running' || state === 'waiting_approval'
  }
  const mustStayFull = new Set(
    ordered.filter(b => issuesFor(b.id).length > 0 || (hasRun && ((draftIds.has(b.id) && !inRun(b)) || activeNow(b.id)))).map(b => b.id),
  )
  const lane = hasRun ? fisheyeLayout(ordered, focusId, mustStayFull) : null
  useEffect(() => {
    layoutRef.current = lane
  })

  // The lane is re-laid-out whenever the focus moves, so the view has to be re-fitted or the far end falls
  // off the screen. Under reduced motion it jumps instead of gliding: a glide is movement.
  const fisheyeFocus = hasRun ? focusId : null
  useEffect(() => {
    if (fisheyeFocus === null) return
    fitLane(reducedMotion ? 0 : 300)
  }, [fisheyeFocus, reducedMotion, fitLane])

  const placementOf = (block: Block) => lane?.get(block.id)
  // The steps layout always shows one step: the one picked by hand or pointed at from the log, else where the work is.
  const steps = layout === 'steps'
  const stateIn = (id: string): NodeState | null => {
    const block = presented.blocks.find(b => b.id === id)
    return hasRun && block && (inRun(block) || !draftIds.has(id)) ? (runById.get(id)?.state ?? 'queued') : null
  }
  const held = (hasRun ? focusOverride : null) ?? selectedId
  const stepPick = steps ? (held && presented.blocks.some(b => b.id === held) ? held : stepToShow(presented.blocks, stateIn)) : null
  const selected = graph.blocks.find(b => b.id === (steps ? stepPick : selectedId)) ?? null
  // The steps layout wears the brand's colours; the canvas keeps its own.
  const skin = steps ? { bg: brand.bg, line: brand.line, panel: brand.card, head: '#1e1e1e' } : { bg: theme.bg, line: theme.border, panel: '#0f141c', head: '#131a24' }
  const removeFromDraft = (id: string) => {
    edit(g => removeBlock(g, id))
    setSelectedId(null)
    setExpandedId(null)
    setFocusOverride(current => (current === id ? null : current))
  }

  // Closing undoes a click: nothing selected, nothing held open, and the canvas follows the work again.
  const close = () => {
    setSelectedId(null)
    setExpandedId(null)
    setFocusOverride(null)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      setSelectedId(null)
      setExpandedId(null)
      setFocusOverride(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Offered on a block that failed, while a run is on screen.
  const failedActions = hasRun && onFailedClick ? { onSee: () => onFailedClick('see'), onAgain: canRetry ? () => onFailedClick('again') : undefined } : undefined
  const built: CardNode[] = [
    ...graph.blocks.map(block => {
      // No run: honestly queued. In a run: the stream's view, or queued when the run holds the block but has said nothing yet.
      // Not in the run: no view at all, drawn as such.
      const view = !hasRun ? queuedView(block) : inRun(block) ? (runById.get(block.id) ?? queuedView(block)) : null
      const placed = placementOf(block)
      return {
        id: block.id,
        type: 'block' as const,
        position: placed
          ? { x: placed.x, y: placed.y }
          : { x: block.position.x + expansionOffsetX(graph, expandedId, block), y: block.position.y },
        data: {
          block: view ? (frozenOf(block) ?? block) : block,
          view,
          highlighted: highlightedId === block.id,
          expanded: hasRun ? block.id === focusId : expandedId === block.id,
          selected: selectedId === block.id,
          issues: issuesFor(block.id),
          // Under the fisheye the lane itself is the breadcrumb: every block is on screen.
          breadcrumb: hasRun ? [] : chainTo(graph, block.id),
          collapsed: placed?.collapsed ?? false,
          cardWidth: hasRun ? CARD_WIDTH : undefined,
          collapseLabel: strings.canvas.close,
          // While a run is on screen a clicked card simply stays open: no button on it. A click on the empty canvas or
          // Escape lets the view follow the work again.
          onCollapse: hasRun ? undefined : close,
          // From the card itself: any removable block while editing, and while a run is on screen only the blocks
          // added since, so a card showing what happened in the run never offers to delete itself.
          onRemove: canRemove(graph, block) && (!hasRun || !view) ? () => removeFromDraft(block.id) : undefined,
          failedActions,
          onDetails: hasRun && onDetails && inRun(block) ? () => onDetails(block.id) : undefined,
        },
      }
    }),
    ...removedFromDraft.map(block => ({
      id: block.id,
      type: 'block' as const,
      position: placementOf(block) ?? { x: block.position.x, y: block.position.y },
      draggable: false,
      data: {
        block,
        view: runById.get(block.id) ?? queuedView(block),
        highlighted: highlightedId === block.id,
        expanded: hasRun ? block.id === focusId : expandedId === block.id,
        selected: false,
        issues: [],
        breadcrumb: hasRun ? [] : chainTo({ blocks: [...(runBlocks ?? [])] }, block.id),
        collapsed: placementOf(block)?.collapsed ?? false,
        cardWidth: hasRun ? CARD_WIDTH : undefined,
        collapseLabel: strings.canvas.close,
        onCollapse: hasRun ? undefined : close,
      },
    })),
  ]
  // The nodes are built afresh on every render, and the flow hides a node whose size it does not know. Each card's
  // measured size is therefore kept here and handed back with it; without that, any redraw (a status arriving, a
  // window opening) could leave cards invisible until something happened to measure them again.
  const nodes: CardNode[] = built.map(n => (sizes[n.id] ? { ...n, measured: sizes[n.id] } : n))
  const drawn = new Set(nodes.map(n => n.id))
  const outsideRun = new Set(nodes.filter(n => n.data.view === null).map(n => n.id))
  const toStored = (id: string, position: { x: number; y: number }) => {
    const block = graphRef.current.blocks.find(b => b.id === id)
    return block ? { x: position.x - expansionOffsetX(graphRef.current, expandedId, block), y: position.y } : position
  }

  const derived = derivedEdges(presented)
  const edges: Edge[] = derived.filter(e => drawn.has(e.from) && drawn.has(e.to)).map(e =>
    e.kind === 'return'
      ? {
          id: `${e.from}->${e.to}:return`,
          source: e.from,
          target: e.to,
          // Both ends use top handles, so the path rises above the lane and comes back down: nothing is ever drawn there.
          sourceHandle: RETURN_OUT,
          targetHandle: RETURN_IN,
          type: 'smoothstep',
          label: strings.canvas.returnEdge,
          style: { stroke: theme.failed, strokeWidth: 2, strokeDasharray: '6 4' },
          labelStyle: { fill: theme.failed },
          markerEnd: { type: MarkerType.ArrowClosed, color: theme.failed },
        }
      : {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          // A cable to a block the run does not contain is drawn dashed: it is the draft's, not the run's.
          style: { stroke: theme.border, strokeWidth: 2, strokeDasharray: outsideRun.has(e.from) || outsideRun.has(e.to) ? '4 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color: theme.border },
        },
  )

  // Particles mean "work is arriving here": only a normal cable whose target is really running, never under reduced motion.
  const cables: Cable[] = reducedMotion
    ? []
    : derived
        .filter(e => e.kind === 'normal' && drawn.has(e.from) && drawn.has(e.to))
        .filter(e => nodes.find(n => n.id === e.to)?.data.view?.state === 'running')
        .map(e => ({ edge: e, from: nodes.find(n => n.id === e.from)!.position, to: nodes.find(n => n.id === e.to)!.position }))

  return (
    <div
      data-testid="canvas"
      data-edges={edges.map(e => e.id).join(',')}
      style={{ display: 'flex', width: '100%', height: '100%', background: skin.bg, color: 'inherit' }}
    >
      {!sidebarOpen && (
        <nav
          data-testid="sidebar-rail"
          aria-label={strings.sidebar.label}
          style={{ width: RAIL_WIDTH, flexShrink: 0, padding: '10px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, borderRight: `1px solid ${skin.line}` }}
        >
          <RailButton icon="expand" label={strings.sidebar.open} onClick={() => setSidebarOpen(true)} />
          <span aria-hidden="true" style={{ width: 24, height: 1, background: theme.border, margin: '4px 0' }} />
          {/* The request box lives in the command card on the canvas, so this puts the cursor there without opening anything. */}
          <RailButton icon="run" label={strings.sidebar.run} onClick={() => document.getElementById(RUN_INPUT_ID)?.focus()} />
          <RailButton icon="add" label={strings.editing.paletteTitle} onClick={() => openAt(PALETTE_SECTION)} />
          <RailButton icon="settings" label={strings.editing.inspectorTitle} onClick={() => openAt(SETTINGS_SECTION)} />
          {sidebarLog && <RailButton icon="log" label={strings.events.barTitle} onClick={() => openAt(LOG_SECTION)} />}
        </nav>
      )}
      <aside
        data-testid="sidebar"
        aria-label={strings.sidebar.label}
        hidden={!sidebarOpen}
        style={{
          width: SIDEBAR_WIDTH,
          flexShrink: 0,
          padding: 12,
          // A column, so the log panel can sit at the very bottom however little is above it.
          display: sidebarOpen ? 'flex' : 'none',
          flexDirection: 'column',
          gap: 20,
          borderRight: `1px solid ${skin.line}`,
          overflowY: 'auto',
          // A thin dark scrollbar: the system's light one is the brightest thing on screen otherwise.
          scrollbarWidth: 'thin',
          scrollbarColor: `${theme.floorLine} transparent`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: theme.dim }}>
            <span style={{ color: '#e8eaf0', display: 'flex' }}><Logo size={22} /></span>
            {strings.app.name}
          </span>
          <RailButton icon="collapse" label={strings.sidebar.close} onClick={() => setSidebarOpen(false)} />
        </div>

        {sidebarTop && (
          <section id={RUN_SECTION} style={{ display: 'grid', gap: 10, paddingBottom: 20, borderBottom: `1px solid ${skin.line}` }}>
            {sidebarTop}
          </section>
        )}

        <section id={PALETTE_SECTION} data-testid="palette" style={{ display: 'grid', gridTemplateColumns: steps ? 'repeat(2, minmax(0, 1fr))' : undefined, gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 14, gridColumn: '1 / -1' }}>{strings.editing.paletteTitle}</h2>
          {addable.length === 0 && <p style={{ margin: 0, gridColumn: '1 / -1', color: theme.skipped }}>{strings.editing.paletteEmpty}</p>}
          {addable.map(kind => (
            <button key={kind} type="button" style={steps ? { ...panelButton, background: brand.card, border: `1px solid ${brand.line}`, textAlign: 'center' } : panelButton} onClick={() => {
                // The new card is chosen at once, so it is plain which one was just added and its settings are open.
                const before = new Set(graphRef.current.blocks.map(b => b.id))
                edit(g => addBlock(g, kind, reservedIds))
                const added = graphRef.current.blocks.find(b => !before.has(b.id))
                if (!added) return
                setSelectedId(added.id)
                if (hasRun) setFocusOverride(added.id)
                else setExpandedId(added.id)
              }}>
              {steps ? `+ ${strings.blocks[kind]}` : strings.blocks[kind]}
            </button>
          ))}
        </section>

        {/* Its own enclosed panel, like the log: a header bar, then the fields, with the same quiet edge. */}
        <section
          id={SETTINGS_SECTION}
          data-testid="block-settings"
          style={{
            flexShrink: 0,
            background: skin.panel,
            border: `1px solid ${skin.line}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 10px',
              background: skin.head,
              borderBottom: `1px solid ${skin.line}`,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: selected ? theme.ink : theme.dim,
              }}
            >
              {strings.editing.inspectorTitle}
            </h2>
            {selected && !steps && (
              <button
                type="button"
                aria-label={strings.editing.closeSettings}
                title={strings.editing.closeSettings}
                onClick={close}
                style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2 }}
              >
                ✕
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gap: 10, padding: 10 }}>
            {selected ? (
              <>
                <BlockInspector
                  block={selected}
                  canDisable={canDisable(graph, selected)}
                  runOnScreen={hasRun}
                  onChange={b => edit(g => updateBlock(g, b))}
                />
                {canRemove(graph, selected) && (
                  <button
                    type="button"
                    style={{ ...panelButton, color: theme.failed }}
                    onClick={() => {
                      edit(g => removeBlock(g, selected.id))
                      setSelectedId(null)
                      setExpandedId(null)
                    }}
                  >
                    {strings.editing.remove}
                  </button>
                )}
              </>
            ) : (
              <p style={{ margin: 0, color: theme.skipped }}>{strings.editing.inspectorEmpty}</p>
            )}
          </div>
        </section>

        {unattributed.length > 0 && (
          <section style={{ display: 'grid', gap: 6, color: theme.failed }}>
            <h2 style={{ margin: 0, fontSize: 14 }}>{strings.editing.unattributedIssues}</h2>
            {unattributed.map(i => (
              <p key={i.message} style={{ margin: 0 }}>
                {i.message}
              </p>
            ))}
          </section>
        )}
        {saveFailed && (
          <p role="alert" style={{ margin: 0, color: theme.failed }}>
            {strings.editing.saveFailed}
          </p>
        )}

        {sidebarLog && (
          // Its own enclosed panel: a header with the title, then a short scroll of lines, newest first.
          <section
            id={LOG_SECTION}
            data-testid="sidebar-log"
            style={{ marginTop: steps ? 0 : 'auto', flexShrink: 0, background: skin.panel, border: `1px solid ${skin.line}`, borderRadius: 10, overflow: 'hidden' }}
          >
            <h2
              style={{
                margin: 0,
                padding: '8px 10px',
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: theme.dim,
                background: skin.head,
                borderBottom: `1px solid ${skin.line}`,
              }}
            >
              {strings.events.barTitle}
            </h2>
            <div style={{ maxHeight: steps ? 'max(380px, calc(100vh - 560px))' : LOG_MAX_HEIGHT, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}>
              {sidebarLog}
            </div>
          </section>
        )}
      </aside>

      <div ref={pane} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {steps && (
          <StepsLane
            blocks={presented.blocks}
            stateOf={stateIn}
            hasRun={hasRun}
            pickedId={stepPick}
            onPick={id => {
              setSelectedId(id)
              if (hasRun) setFocusOverride(id)
            }}
            title={overlay}
            detail={stepPick && stateIn(stepPick) !== null ? stepDetails?.(stepPick) : undefined}
            blank={blank}
            loading={loading}
          />
        )}
        {!steps && (
          <>
        <Depth floorRef={floorRef} />
        {overlay}
        {loading && <LaneSkeleton count={runBlocks?.length ?? graph.blocks.length} />}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          // While the lane lays itself out around the work, cards glide to their new places instead of jumping.
          className={hasRun && !reducedMotion ? 'factory-glide' : undefined}
          style={{ background: 'transparent', zIndex: 1, opacity: loading || blank ? 0 : 1, pointerEvents: blank ? 'none' : undefined, transition: reducedMotion ? 'none' : 'opacity 220ms ease-out' }}
          onMove={(_, vp) => parallax(vp)}
          onPaneClick={close}
          onInit={instance => {
            flow.current = instance
            // Placed at once from the layout, so a reload lands in the same spot instead of settling later.
            fitLane(0)
            parallax(instance.getViewport())
          }}
          onNodeClick={(_, node) => {
            setSelectedId(node.id)
            // A click opens the block and keeps it open; Close, Escape or a click on the empty canvas undoes it.
            if (hasRun) setFocusOverride(node.id)
            else setExpandedId(node.id)
          }}
          onNodesChange={changes => {
            // Follow the pointer while dragging; nothing is saved until the drag ends.
            for (const c of changes) {
              if (c.type === 'dimensions' && c.dimensions) {
                const { width, height } = c.dimensions
                setSizes(prev => (prev[c.id]?.width === width && prev[c.id]?.height === height ? prev : { ...prev, [c.id]: { width, height } }))
              }
              if (c.type === 'position' && c.position) {
                // The pointer sees the pushed position; the stored one is without the transient offset.
                const stored = toStored(c.id, c.position)
                edit(g => moveBlock(g, c.id, stored), false)
              }
            }
          }}
          onNodeDragStop={(_, node) => {
            const stored = toStored(node.id, node.position)
            edit(g => moveBlock(g, node.id, stored))
          }}
          nodesDraggable={!hasRun}
          nodesConnectable={false}
          deleteKeyCode={null}
          fitView={!hasRun}
          fitViewOptions={FIT}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <ViewportPortal>
            <ParticleLayer cables={cables} />
          </ViewportPortal>
        </ReactFlow>
          </>
        )}
      </div>
    </div>
  )
}

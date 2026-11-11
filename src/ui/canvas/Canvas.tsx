'use client'

import { Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance, ViewportPortal } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { derivedEdges, STAGE_ORDER, type Block, type Graph, type ValidationIssue } from '@/domain/graph'
import { summarize } from '@/domain/summary'
import { BlockInspector } from './BlockInspector'
import { addBlock, addableKinds, canDisable, canRemove, chainTo, moveBlock, removeBlock, updateBlock } from './editing'
import { theme } from '@/ui/theme'
import { strings } from '@/ui/strings'
import { Depth } from './Depth'
import { ParticleLayer, type Cable } from './FlowParticles'
import { useReducedMotion } from './useReducedMotion'
import { BlockCard, CARD_WIDTH, EXPANDED_CARD_WIDTH, NotInRunCard, SpineCard, type NodeRunView } from './BlockCard'
import { autoFocus, fisheyeLayout } from './fisheye'
import { SidebarIcon, type SidebarIconName } from './SidebarIcons'
import { usePersistentFlag } from './usePersistentFlag'

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
        // Hover lifts the card off the floor. Under reduced motion it stays put: lift is movement.
        boxShadow: theme.elevation(lifted ? 2 : 0),
        transform: lifted ? 'translateY(-3px)' : 'none',
        transition: reduced ? 'none' : 'transform 120ms ease-out, box-shadow 120ms ease-out',
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
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
          width={data.cardWidth}
        />
      ) : (
        <NotInRunCard block={data.block} selected={data.selected} issues={data.issues} />
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {/* Bottom handles carry the return cable so it loops beneath the lane. */}
      <Handle id={RETURN_OUT} type="source" position={Position.Bottom} isConnectable={false} />
      <Handle id={RETURN_IN} type="target" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

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
}: {
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
  const selected = graph.blocks.find(b => b.id === selectedId) ?? null
  const addable = addableKinds(graph)
  const flow = useRef<ReactFlowInstance<CardNode> | null>(null)
  const reducedMotion = useReducedMotion()
  const [sidebarOpen, setSidebarOpen] = usePersistentFlag(SIDEBAR_KEY, true)
  // The canvas gets wider or narrower when the sidebar moves, so the lane is fitted again rather than left off-centre.
  useEffect(() => {
    // Two frames: the first lays out the new width, the second lets the flow measure it before fitting to it.
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => void flow.current?.fitView({ duration: reducedMotion ? 0 : 300, maxZoom: 1 }))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [sidebarOpen, reducedMotion])
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
    if (highlightedId) void flow.current?.fitView({ nodes: [{ id: highlightedId }], duration: 300, maxZoom: 1 })
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
  // Two kinds of block never collapse, because a spine has nowhere to say what is wrong with them: one
  // carrying a validation message, and one the run does not contain at all.
  const mustStayFull = new Set(
    ordered.filter(b => issuesFor(b.id).length > 0 || (hasRun && draftIds.has(b.id) && !inRun(b))).map(b => b.id),
  )
  const layout = hasRun ? fisheyeLayout(ordered, focusId, mustStayFull) : null

  // The lane is re-laid-out whenever the focus moves, so the view has to be re-fitted or the far end falls
  // off the screen. Under reduced motion it jumps instead of gliding: a glide is movement.
  const fisheyeFocus = hasRun ? focusId : null
  useEffect(() => {
    if (fisheyeFocus === null) return
    void flow.current?.fitView({ duration: reducedMotion ? 0 : 300, maxZoom: 1 })
  }, [fisheyeFocus, reducedMotion])

  const placementOf = (block: Block) => layout?.get(block.id)
  const unpin = focusOverride === null ? undefined : () => setFocusOverride(null)

  const nodes: CardNode[] = [
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
          collapseLabel: hasRun ? strings.canvas.followWork : strings.canvas.collapse,
          onCollapse: hasRun ? unpin : () => setExpandedId(null),
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
        collapseLabel: hasRun ? strings.canvas.followWork : strings.canvas.collapse,
        onCollapse: hasRun ? unpin : () => setExpandedId(null),
      },
    })),
  ]
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
          // Both ends use bottom handles, so the path drops below the lane and back up.
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
      style={{ display: 'flex', width: '100%', height: '100%', background: theme.bg, color: 'inherit' }}
    >
      {!sidebarOpen && (
        <nav
          data-testid="sidebar-rail"
          aria-label={strings.sidebar.label}
          style={{ width: RAIL_WIDTH, flexShrink: 0, padding: '10px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, borderRight: `1px solid ${theme.border}` }}
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
          borderRight: `1px solid ${theme.border}`,
          overflowY: 'auto',
          // A thin dark scrollbar: the system's light one is the brightest thing on screen otherwise.
          scrollbarWidth: 'thin',
          scrollbarColor: `${theme.floorLine} transparent`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: theme.dim }}>{strings.app.name}</span>
          <RailButton icon="collapse" label={strings.sidebar.close} onClick={() => setSidebarOpen(false)} />
        </div>

        {sidebarTop && (
          <section id={RUN_SECTION} style={{ display: 'grid', gap: 10, paddingBottom: 20, borderBottom: `1px solid ${theme.border}` }}>
            {sidebarTop}
          </section>
        )}

        <section id={PALETTE_SECTION} data-testid="palette" style={{ display: 'grid', gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>{strings.editing.paletteTitle}</h2>
          {addable.length === 0 && <p style={{ margin: 0, color: theme.skipped }}>{strings.editing.paletteEmpty}</p>}
          {addable.map(kind => (
            <button key={kind} type="button" style={panelButton} onClick={() => edit(g => addBlock(g, kind, reservedIds))}>
              {strings.blocks[kind]}
            </button>
          ))}
        </section>

        <section id={SETTINGS_SECTION} style={{ display: 'grid', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>{strings.editing.inspectorTitle}</h2>
          {selected ? (
            <>
              <BlockInspector
                block={selected}
                canDisable={canDisable(graph, selected)}
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
            style={{ marginTop: 'auto', flexShrink: 0, background: '#0f141c', border: `1px solid ${theme.border}`, borderRadius: 10, overflow: 'hidden' }}
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
                background: '#131a24',
                borderBottom: `1px solid ${theme.border}`,
              }}
            >
              {strings.events.barTitle}
            </h2>
            <div style={{ maxHeight: LOG_MAX_HEIGHT, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}>
              {sidebarLog}
            </div>
          </section>
        )}
      </aside>

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <Depth floorRef={floorRef} />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          style={{ background: 'transparent', zIndex: 1 }}
          onMove={(_, vp) => parallax(vp)}
          onInit={instance => {
            flow.current = instance
            parallax(instance.getViewport())
          }}
          onNodeClick={(_, node) => {
            setSelectedId(node.id)
            // Under the fisheye a click chooses the focus; clicking the open block hands the follow back.
            if (hasRun) setFocusOverride(current => (current === node.id ? null : node.id))
            else setExpandedId(current => (current === node.id ? null : node.id))
          }}
          onNodesChange={changes => {
            // Follow the pointer while dragging; nothing is saved until the drag ends.
            for (const c of changes) {
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
          fitView
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <ViewportPortal>
            <ParticleLayer cables={cables} />
          </ViewportPortal>
        </ReactFlow>
      </div>
    </div>
  )
}

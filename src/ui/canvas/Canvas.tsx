'use client'

import { Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance, ViewportPortal } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { derivedEdges, type Block, type Graph, type ValidationIssue } from '@/domain/graph'
import { summarize } from '@/domain/summary'
import { BlockInspector } from './BlockInspector'
import { addBlock, addableKinds, canDisable, canRemove, chainTo, moveBlock, removeBlock, updateBlock } from './editing'
import { theme } from '@/ui/theme'
import { strings } from '@/ui/strings'
import { Depth } from './Depth'
import { ParticleLayer, type Cable } from './FlowParticles'
import { useReducedMotion } from './useReducedMotion'
import { BlockCard, CARD_WIDTH, EXPANDED_CARD_WIDTH, NotInRunCard, type NodeRunView } from './BlockCard'

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
  onCollapse: () => void
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
      {data.view ? (
        <BlockCard
          block={data.block}
          view={data.view}
          expanded={data.expanded}
          selected={data.selected}
          issues={data.issues}
          breadcrumb={data.breadcrumb}
          onCollapse={data.onCollapse}
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
}) {
  const [graph, setGraph] = useState(initialGraph)
  const [selectedId, setSelectedId] = useState<string | null>(initialExpandedId)
  // Expansion is a view state only: it never enters the graph and so is never saved.
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
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
  const nodes: CardNode[] = [
    ...graph.blocks.map(block => {
      // No run: honestly queued. In a run: the stream's view, or queued when the run holds the block but has said nothing yet.
      // Not in the run: no view at all, drawn as such.
      const view = !hasRun ? queuedView(block) : inRun(block) ? (runById.get(block.id) ?? queuedView(block)) : null
      return {
        id: block.id,
        type: 'block' as const,
        position: { x: block.position.x + expansionOffsetX(graph, expandedId, block), y: block.position.y },
        data: {
          block: view ? (frozenOf(block) ?? block) : block,
          view,
          highlighted: highlightedId === block.id,
          expanded: expandedId === block.id,
          selected: selectedId === block.id,
          issues: issuesFor(block.id),
          breadcrumb: chainTo(graph, block.id),
          onCollapse: () => setExpandedId(null),
        },
      }
    }),
    ...removedFromDraft.map(block => ({
      id: block.id,
      type: 'block' as const,
      position: { x: block.position.x, y: block.position.y },
      draggable: false,
      data: {
        block,
        view: runById.get(block.id) ?? queuedView(block),
        highlighted: highlightedId === block.id,
        expanded: expandedId === block.id,
        selected: false,
        issues: [],
        breadcrumb: chainTo({ blocks: [...(runBlocks ?? [])] }, block.id),
        onCollapse: () => setExpandedId(null),
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
      <aside
        style={{
          width: 260,
          flexShrink: 0,
          padding: 12,
          display: 'grid',
          alignContent: 'start',
          gap: 20,
          borderRight: `1px solid ${theme.border}`,
          overflowY: 'auto',
        }}
      >
        <section data-testid="palette" style={{ display: 'grid', gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>{strings.editing.paletteTitle}</h2>
          {addable.length === 0 && <p style={{ margin: 0, color: theme.skipped }}>{strings.editing.paletteEmpty}</p>}
          {addable.map(kind => (
            <button key={kind} type="button" style={panelButton} onClick={() => edit(g => addBlock(g, kind, reservedIds))}>
              {strings.blocks[kind]}
            </button>
          ))}
        </section>

        <section style={{ display: 'grid', gap: 10 }}>
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
            setExpandedId(current => (current === node.id ? null : node.id))
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
          nodesDraggable
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

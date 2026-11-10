'use client'

import { Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { derivedEdges, type Block, type Graph, type ValidationIssue } from '@/domain/graph'
import { summarize } from '@/domain/summary'
import { BlockInspector } from './BlockInspector'
import { addBlock, addableKinds, canDisable, canRemove, moveBlock, removeBlock, updateBlock } from './editing'
import { theme } from '@/ui/theme'
import { strings } from '@/ui/strings'
import { BlockCard, type NodeRunView } from './BlockCard'

export type { NodeRunView }

const RETURN_OUT = 'return-out'
const RETURN_IN = 'return-in'

type CardData = { block: Block; view: NodeRunView; expanded: boolean; issues: string[] }
type CardNode = Node<CardData, 'block'>

function BlockNode({ data }: NodeProps<CardNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <BlockCard block={data.block} view={data.view} expanded={data.expanded} selected={data.expanded} issues={data.issues} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {/* Bottom handles carry the return cable so it loops beneath the lane. */}
      <Handle id={RETURN_OUT} type="source" position={Position.Bottom} isConnectable={false} />
      <Handle id={RETURN_IN} type="target" position={Position.Bottom} isConnectable={false} />
    </>
  )
}

const nodeTypes = { block: BlockNode }

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

export function Canvas({
  graph: initialGraph,
  nodeRuns = [],
  save,
}: {
  graph: Graph
  nodeRuns?: NodeRunView[]
  /** Persists the draft and returns what is wrong with it. Absent: edits stay on screen only. */
  save?: (graph: Graph) => Promise<ValidationIssue[]>
}) {
  const [graph, setGraph] = useState(initialGraph)
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const persist = saveRef.current
    if (!dirty.current || !persist) return
    dirty.current = false
    const mine = ++seq.current
    // Only the newest response may touch the screen; an older one is stale.
    persist(graphRef.current).then(
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
  }, [])

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

  // The queued default is only true when there is no run. Once a run exists, a block it has no view for is
  // not part of that run, so it is not drawn rather than shown with an invented state.
  const hasRun = nodeRuns.length > 0
  const nodes: CardNode[] = graph.blocks.flatMap(block => {
    const view = hasRun ? runById.get(block.id) : queuedView(block)
    if (!view) return []
    return [
      {
        id: block.id,
        type: 'block' as const,
        position: block.position,
        data: { block, view, expanded: selectedId === block.id, issues: issuesFor(block.id) },
      },
    ]
  })
  const drawn = new Set(nodes.map(n => n.id))

  const derived = derivedEdges(graph)
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
          style: { stroke: theme.border, strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: theme.border },
        },
  )

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
            <button key={kind} type="button" style={panelButton} onClick={() => edit(g => addBlock(g, kind))}>
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

      <div style={{ flex: 1, minWidth: 0 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelectedId(current => (current === node.id ? null : node.id))}
          onNodesChange={changes => {
            // Follow the pointer while dragging; nothing is saved until the drag ends.
            for (const c of changes) {
              if (c.type === 'position' && c.position) {
                const position = c.position
                edit(g => moveBlock(g, c.id, position), false)
              }
            }
          }}
          onNodeDragStop={(_, node) => edit(g => moveBlock(g, node.id, node.position))}
          nodesDraggable
          nodesConnectable={false}
          deleteKeyCode={null}
          fitView
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background color={theme.border} />
        </ReactFlow>
      </div>
    </div>
  )
}

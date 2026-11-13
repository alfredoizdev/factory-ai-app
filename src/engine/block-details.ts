import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, evidence, nodeRuns, runs, usageRecords, workflowVersions } from '@/db/schema'
import type { Graph } from '@/domain/graph'

// Everything recorded about one block of a run, for the "See details" window: what it said, every step it took, how
// long it worked, the tokens it used, the plan it proposed and what its commands measured. Read-only, and only what
// was already stored (steps and outputs were redacted when they were written).

export type BlockCommand = { command: string; exitCode: number | null; signal: string | null; durationMs: number | null; output: string | null }

export type BlockDetails = {
  blockId: string
  label: string
  kind: string
  state: string
  attempt: number
  startedAt: string | null
  finishedAt: string | null
  /** How long it worked, start to finish; null while it has not finished (or never started). */
  durationMs: number | null
  /** The model written on the block, when it has one of its own. */
  model: string | null
  /** Null: nothing was reported. */
  tokens: number | null
  /** The sentence the block ended with: what the agent said it did, or why it failed or was skipped. */
  summary: string | null
  /** Every step it took, in order, with when. */
  steps: { text: string; at: string }[]
  /** The jobs of the plan, on the Plan block. */
  jobs: { title: string; done: string[]; paths?: string[] }[]
  /** Why the plan stopped for the person or started on its own, and the files or folders it expects to change. Plan block only. */
  planMeasure?: { simple: boolean; reasons: string[]; entries: string[]; question?: string }
  commands: BlockCommand[]
  /**
   * Every task of the change this one belongs to, oldest first: the first task and each one that continued from it.
   * On the Human check and Ship blocks, where the person looks back at what was done.
   */
  history?: { runId: string; name: string; request: string; at: string; here: boolean }[]
}

/** The tasks that make up one change: the run's oldest ancestor and everything that continued from it, in order. */
async function historyOf(run: typeof runs.$inferSelect): Promise<NonNullable<BlockDetails['history']>> {
  const all = await db.select().from(runs).where(eq(runs.workflowId, run.workflowId)).orderBy(asc(runs.createdAt))
  const byId = new Map(all.map(r => [r.id, r]))
  const rootOf = (r: typeof runs.$inferSelect): string => {
    let at = r
    const seen = new Set<string>()
    while (at.parentRunId && byId.has(at.parentRunId) && !seen.has(at.id)) {
      seen.add(at.id)
      at = byId.get(at.parentRunId)!
    }
    return at.id
  }
  const root = rootOf(run)
  return all
    .filter(r => rootOf(r) === root)
    .map(r => ({ runId: r.id, name: r.title?.trim() || r.request.replace(/\s+/g, ' ').trim().slice(0, 80), request: r.request, at: r.createdAt, here: r.id === run.id }))
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

export async function blockDetails(runId: string, blockId: string): Promise<BlockDetails | null> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return null
  const node = (await db.select().from(nodeRuns).where(and(eq(nodeRuns.runId, runId), eq(nodeRuns.blockId, blockId))))[0]
  if (!node) return null
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]
  const block = version ? (JSON.parse(version.graphJson) as Graph).blocks.find(b => b.id === blockId) : undefined
  const log = await db.select().from(events).where(and(eq(events.runId, runId), eq(events.nodeRunId, node.id))).orderBy(asc(events.sequence))

  const steps: BlockDetails['steps'] = []
  let summary: string | null = node.summary
  let jobs: BlockDetails['jobs'] = []
  let planMeasure: BlockDetails['planMeasure']
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  for (const e of log) {
    const p = JSON.parse(e.payloadJson) as Record<string, unknown>
    // A new round starts the block over: what it did before no longer describes it.
    if (e.type === 'node.reopened') {
      steps.length = 0
      planMeasure = undefined
    }
    if (e.type === 'node.step' && text(p.text)) steps.push({ text: p.text as string, at: e.createdAt })
    if (e.type === 'node.completed' || e.type === 'node.waiting_approval') summary = text(p.summary) ?? summary
    if (e.type === 'node.failed') summary = text(p.message) ?? summary
    if (e.type === 'node.skipped') summary = text(p.reason) ?? summary
    if (e.type === 'node.planned' && Array.isArray(p.jobs)) {
      jobs = p.jobs
        .filter((j): j is { title: string; done?: unknown; paths?: unknown } => typeof (j as { title?: unknown })?.title === 'string')
        .map(j => (Array.isArray(j.paths) ? { title: j.title, done: strs(j.done), paths: strs(j.paths) } : { title: j.title, done: strs(j.done) }))
    }
    if (e.type === 'node.plan_measured') {
      const q = (p.question as { text?: unknown } | null | undefined)?.text
      planMeasure = { simple: p.simple === true, reasons: strs(p.reasons), entries: strs(p.entries), ...(typeof q === 'string' && q.trim() !== '' ? { question: q } : {}) }
    }
  }

  const used = await db.select().from(usageRecords).where(eq(usageRecords.nodeRunId, node.id))
  const counted = used.filter(u => u.tokens !== null)
  const measured = await db.select().from(evidence).where(eq(evidence.nodeRunId, node.id)).orderBy(asc(evidence.createdAt), asc(evidence.id))
  const commands = measured.flatMap((m): BlockCommand[] => {
    const d = JSON.parse(m.dataJson) as { command?: unknown; exitCode?: unknown; signal?: unknown; durationMs?: unknown; outputTail?: unknown }
    if (typeof d.command !== 'string') return []
    return [{ command: d.command, exitCode: typeof d.exitCode === 'number' ? d.exitCode : null, signal: text(d.signal), durationMs: typeof d.durationMs === 'number' ? d.durationMs : null, output: text(d.outputTail)?.trim() ?? null }]
  })
  const model = (block?.config as { model?: unknown } | undefined)?.model
  const ms = node.startedAt && node.finishedAt ? Date.parse(node.finishedAt) - Date.parse(node.startedAt) : NaN
  return {
    blockId,
    label: block?.label ?? blockId,
    kind: block?.kind ?? 'unknown',
    state: node.state,
    attempt: node.attempt,
    startedAt: node.startedAt,
    finishedAt: node.finishedAt,
    durationMs: Number.isFinite(ms) && ms >= 0 ? ms : null,
    model: text(model),
    tokens: counted.length > 0 ? counted.reduce((sum, u) => sum + (u.tokens ?? 0), 0) : null,
    summary,
    steps,
    jobs,
    ...(planMeasure ? { planMeasure } : {}),
    commands,
    ...(block?.kind === 'ship' || block?.kind === 'human' ? { history: await historyOf(run) } : {}),
  }
}

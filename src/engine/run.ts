import { baseIsStale, prepareBase } from '@/engine/base'
import { branchCommit, defaultBranch, freshestStart } from '@/engine/branches'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { events, nodeRuns, projects, runs, workflows, workflowVersions } from '@/db/schema'
import { STAGE_ORDER, validateGraph, type Graph, type ValidationIssue } from '@/domain/graph'
import { canTransition, type NodeState } from '@/domain/states'
import { appendEventSync, lockRun } from '@/engine/events'
import { passedOnItsOwnAmong } from '@/engine/passed-check'
import { onHoldAmong } from '@/engine/ship'
import { cleanTitle, titleOf } from '@/engine/title'
import { CLAUDE_PROVIDER_ID, DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'
import { projectHere, thisMachine } from '@/engine/machine'

// The boundary between designing and running. The draft is mutable; publishing freezes a version;
// a run binds to a frozen version and never reads the draft again.

// A run is the demo unless a real agent is chosen. The UI's Demo badge checks runs.providerId against this constant;
// it is defined in a dependency-free module and re-exported here so existing imports keep working.
export { DEMO_PROVIDER_ID }

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`${strings.errors.workflowNotFound} (${id})`)
  }
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`${strings.errors.runNotFound} (${id})`)
  }
}

/** The branch a task was asked to start from does not exist in the project. */
export class StartBranchError extends Error {
  constructor(branch: string) {
    super(strings.run.noSuchBranch(branch))
    this.name = 'StartBranchError'
  }
}

export class RepoNotSetError extends Error {
  constructor() {
    super(strings.errors.repoNotSet)
    this.name = 'RepoNotSetError'
  }
}

export class NothingPublishedError extends Error {
  constructor() {
    super(strings.errors.nothingPublished)
  }
}

export class PublishRefusedError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`${strings.errors.cannotPublish} ${issues.map(i => i.code).join(', ')}`)
  }
}

const now = () => new Date().toISOString()

async function requireWorkflow(workflowId: string) {
  const wf = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0]
  if (!wf) throw new WorkflowNotFoundError(workflowId)
  return wf
}

// Keys sorted at every depth so the output is independent of property order.
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalise(v)]),
    )
  }
  return value
}

// Positions are presentation, not meaning: moving a block must not mint a new version.
export function hashGraph(graph: Graph): string {
  const meaningful = { blocks: graph.blocks.map(({ position: _position, ...rest }) => rest) }
  return createHash('sha256').update(JSON.stringify(canonicalise(meaningful))).digest('hex')
}

// An invalid draft is still saved (the user is mid-edit); the issues are returned so the canvas can show them.
/** The draft changed since the page that is saving loaded it: saving would silently undo someone else's edit. */
export class DraftConflictError extends Error {
  constructor() {
    super('The flow changed since this page loaded it')
    this.name = 'DraftConflictError'
  }
}

/**
 * Saves the draft. With `base` (the draft's updatedAt the page last saw), the save happens only when the draft is
 * still that version — so a page left open from earlier cannot overwrite a newer flow. Returns the new version.
 */
export async function saveDraft(workflowId: string, graph: Graph, base?: string): Promise<ValidationIssue[]> {
  return (await saveDraftVersioned(workflowId, graph, base)).issues
}

export async function saveDraftVersioned(workflowId: string, graph: Graph, base?: string): Promise<{ issues: ValidationIssue[]; updatedAt: string }> {
  await requireWorkflow(workflowId)
  const updatedAt = (await db.transaction(
    async tx => {
      // Locked until this save commits: two saves of one flow take turns, so the second sees the first and is refused.
      const row = (await tx.select().from(workflows).where(eq(workflows.id, workflowId)).for('update'))[0]!
      if (base !== undefined && row.updatedAt !== base) throw new DraftConflictError()
      // Strictly later than the version replaced, even within the same millisecond, so versions never repeat.
      let stamp = now()
      if (stamp <= row.updatedAt) stamp = new Date(Date.parse(row.updatedAt) + 1).toISOString()
      await tx.update(workflows).set({ draftJson: JSON.stringify(graph), updatedAt: stamp }).where(eq(workflows.id, workflowId))
      return stamp
    },
  ))
  return { issues: validateGraph(graph), updatedAt }
}

export async function publishVersion(workflowId: string): Promise<{ versionId: string; hash: string }> {
  return db.transaction(
    async tx => {
      // One publish of a flow at a time, so two at once cannot both mint a version of the same draft.
      const wf = (await tx.select().from(workflows).where(eq(workflows.id, workflowId)).for('update'))[0]
      if (!wf) throw new WorkflowNotFoundError(workflowId)

      const graph = JSON.parse(wf.draftJson) as Graph
      const issues = validateGraph(graph)
      if (issues.length > 0) throw new PublishRefusedError(issues)

      const hash = hashGraph(graph)
      const latest = (await tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflowId))
        // Newest first: created time, then the ULID (which sorts by time) to break a tie within one millisecond.
        .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
        .limit(1)
        )[0]
      // Same meaning as the latest version: reuse it rather than minting a duplicate.
      if (latest && latest.hash === hash) return { versionId: latest.id, hash }

      const versionId = ulid()
      await tx.insert(workflowVersions)
        .values({
          id: versionId,
          projectId: wf.projectId,
          workflowId,
          graphJson: JSON.stringify(graph),
          hash,
          createdAt: now(),
        })
        
      return { versionId, hash }
    },
  )
}

export type RunProviderId = typeof DEMO_PROVIDER_ID | typeof CLAUDE_PROVIDER_ID

export async function createRun(input: {
  workflowId: string
  request: string
  /** Absent: the demo. A real agent is only ever chosen explicitly. */
  providerId?: RunProviderId
  /** The branch a real run starts from. Absent: the project's main branch, whatever branch the folder is on. */
  startFrom?: string
  /** The person's name for the task. Absent: none, until they give one. */
  title?: string
  /** The person asked to be stopped for this task whatever the project's ask mode says. Absent: no. */
  stopForMe?: boolean
  /** Direct edit: each request only builds, with the site in view; the checks run once, when the person says it is done. */
  direct?: boolean
}): Promise<{ runId: string; versionId: string }> {
  const wf = (await requireWorkflow(input.workflowId))
  const providerId = input.providerId ?? DEMO_PROVIDER_ID
  // Refused before anything is written: a real run with nowhere to work would only fail later, after a row exists.
  let baseCommit: string | null = null
  if (providerId === CLAUDE_PROVIDER_ID) {
    const project = await projectHere(wf.projectId)
    if (!project?.repoPath) throw new RepoNotSetError()
    // Fixed now, as a commit: the agent's copy starts there even if the person switches branches meanwhile.
    const main = defaultBranch(project.repoPath)
    const branch = input.startFrom?.trim() || main
    if (branch) {
      // The main branch, asked for by name or by default, is brought up to date with origin first, so a task never
      // starts behind what was merged there. Any other branch the person picked is used exactly as it is in their folder.
      baseCommit = branch === main ? ((await freshestStart(project.repoPath, branch))?.commit ?? null) : branchCommit(project.repoPath, branch)
      if (!baseCommit) throw new StartBranchError(branch)
      // The prepared base is rebuilt in the background when main's lockfile moved on from the one it holds. This task
      // installs for itself meanwhile; the next ones copy again.
      if (branch === main && (await baseIsStale(wf.projectId, baseCommit))) void prepareBase(wf.projectId)
    }
  }
  // Latest published version only. The draft is never consulted.
  const version = (await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, input.workflowId))
    .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
    .limit(1)
    )[0]
  if (!version) throw new NothingPublishedError()

  const runId = ulid()
  // The run row and run.created commit together: a crash cannot leave a run with no events.
  await db.transaction(
    async tx => {
      await tx.insert(runs)
        .values({
          id: runId,
          projectId: wf.projectId,
          workflowId: wf.id,
          versionId: version.id,
          status: 'queued',
          request: input.request,
          title: input.title ? cleanTitle(input.title) : null,
          titleByPerson: !!(input.title && cleanTitle(input.title)),
          stopForMe: input.stopForMe === true,
          providerId,
          // The run executes here: its working copy and its Inngest are on this computer.
          machineId: thisMachine().id,
          baseCommit,
          createdAt: now(),
        })
        
      await appendEventSync({ runId, type: 'run.created', payload: { versionId: version.id, ...(input.direct === true && providerId === CLAUDE_PROVIDER_ID ? { direct: true } : {}) } }, tx)
      // Every block of the frozen version becomes a queued node run now (the design's section 7, step 2), so a block
      // a run never reaches can be ended as cancelled instead of reading "Queued" for ever.
      const graph = JSON.parse(version.graphJson) as Graph
      for (const kind of STAGE_ORDER) {
        for (const block of graph.blocks.filter(b => b.kind === kind)) {
          const row = (await tx
            .insert(nodeRuns)
            .values({ id: ulid(), projectId: wf.projectId, runId, blockId: block.id, state: 'queued', attempt: 1 })
            .returning()
            )[0]!
          await appendEventSync({ runId, nodeRunId: row.id, type: 'node.queued', payload: { blockId: block.id } }, tx)
        }
      }
    },
  )
  return { runId, versionId: version.id }
}

// Persistence half only: marks the run cancelled so the durable execution function can observe it between steps
// and abort the in-flight provider. Every node that has not finished is cancelled with it, so a cancelled run never
// shows a node still running. The run row, node rows and their events commit in one transaction; a run that already
// finished is left as it is.
export async function cancelRun(runId: string): Promise<void> {
  (await db.transaction(
    async tx => {
      await lockRun(tx, runId)
      const run = (await tx.select().from(runs).where(eq(runs.id, runId)))[0]
      if (!run) throw new RunNotFoundError(runId)
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return
      const finishedAt = now()
      await tx.update(runs).set({ status: 'cancelled', finishedAt }).where(eq(runs.id, runId))
      for (const node of (await tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))) {
        if (!canTransition(node.state as NodeState, 'cancelled')) continue
        await tx.update(nodeRuns).set({ state: 'cancelled', finishedAt }).where(eq(nodeRuns.id, node.id))
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.cancelled', payload: { blockId: node.blockId } }, tx)
      }
      await appendEventSync({ runId, type: 'run.cancelled' }, tx)
    },
  ))
}

// For a run whose execution could not be requested: ends it as failed (status and event together) so it does not sit queued.
export async function failUnstartedRun(runId: string): Promise<void> {
  (await db.transaction(
    async tx => {
      await lockRun(tx, runId)
      const run = (await tx.select().from(runs).where(eq(runs.id, runId)))[0]
      if (!run || run.status !== 'queued') return
      await tx.update(runs).set({ status: 'failed', finishedAt: now() }).where(eq(runs.id, runId))
      // Nothing will ever run these blocks; leaving them queued would say they are still to come.
      for (const node of (await tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)))) {
        if (!canTransition(node.state as NodeState, 'cancelled')) continue
        await tx.update(nodeRuns).set({ state: 'cancelled', finishedAt: now() }).where(eq(nodeRuns.id, node.id))
        await appendEventSync({ runId, nodeRunId: node.id, type: 'node.cancelled', payload: { blockId: node.blockId, reason: strings.run.couldNotStart } }, tx)
      }
      await appendEventSync({ runId, type: 'run.failed', payload: { cause: 'not_started', message: strings.run.couldNotStart } }, tx)
    },
  ))
}

export type RunSummary = {
  runId: string
  request: string
  status: string
  createdAt: string
  branch: string | null
  providerId: string
  parentRunId: string | null
  /** What the person called the task; null until they name it. */
  title: string | null
  /** Its pull request is ready and the person put it on hold. */
  onHold: boolean
  /** The app passed the human check on its own; no person approved. */
  passedOnItsOwn: boolean
  /** What the task needs next from the person, or where it ended up; null when nothing is asked of them. */
  next: NextStep | null
  /** While it works: which step it is on, of how many, and that step's name. */
  progress: { step: number; of: number; name: string } | null
  /** While it waits for the person: the first reason it stopped, in words. */
  why: string | null
}

/**
 * plan: a plan waits for a yes. check: the finished change waits to be looked at (or a question waits for an answer).
 * send: saved on this computer, not on GitHub yet. publish: on GitHub as a pull request, not part of the project yet.
 * published: merged.
 */
export type NextStep = 'plan' | 'check' | 'send' | 'publish' | 'published'

/** How far each working task is: the steps of its flow that are done, and the one being worked on. */
export async function progressAmong(rows: readonly { runId: string; status: string; versionId: string }[]): Promise<Map<string, { step: number; of: number; name: string }>> {
  const out = new Map<string, { step: number; of: number; name: string }>()
  const working = rows.filter(r => r.status === 'running' || r.status === 'queued')
  if (working.length === 0) return out
  const blocksOf = new Map<string, { id: string; label: string }[]>()
  for (const v of await db.select().from(workflowVersions).where(inArray(workflowVersions.id, [...new Set(working.map(r => r.versionId))]))) {
    try {
      blocksOf.set(v.id, (JSON.parse(v.graphJson) as Graph).blocks.filter(b => b.enabled).map(b => ({ id: b.id, label: b.label })))
    } catch {
      blocksOf.set(v.id, [])
    }
  }
  const nodes = await db.select({ runId: nodeRuns.runId, blockId: nodeRuns.blockId, state: nodeRuns.state }).from(nodeRuns).where(inArray(nodeRuns.runId, working.map(r => r.runId)))
  for (const r of working) {
    const blocks = blocksOf.get(r.versionId) ?? []
    if (blocks.length === 0) continue
    const mine = nodes.filter(n => n.runId === r.runId)
    const done = mine.filter(n => n.state === 'passed' || n.state === 'skipped').length
    const now = mine.find(n => n.state === 'running')
    const at = now ? blocks.find(b => b.id === now.blockId) : blocks[Math.min(done, blocks.length - 1)]
    out.set(r.runId, { step: Math.min(done + 1, blocks.length), of: blocks.length, name: at?.label ?? '' })
  }
  return out
}

/** Why each waiting task stopped: the first reason given when its plan or its change was measured. */
export async function whyAmong(rows: readonly { runId: string; status: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = rows.filter(r => r.status === 'waiting_approval').map(r => r.runId)
  if (ids.length === 0) return out
  const found = await db
    .select({ runId: events.runId, payloadJson: events.payloadJson })
    .from(events)
    .where(and(inArray(events.runId, ids), inArray(events.type, ['node.plan_measured', 'node.assessed'])))
    .orderBy(asc(events.sequence))
  for (const e of found) {
    const reasons = (JSON.parse(e.payloadJson) as { reasons?: unknown }).reasons
    const first = Array.isArray(reasons) ? reasons.find(x => typeof x === 'string' && x.trim() !== '') : undefined
    if (typeof first === 'string') out.set(e.runId, first)
  }
  return out
}

/** Each task's next step, from what was written down about it: one query, and GitHub is not asked. */
export async function nextStepAmong(rows: readonly { runId: string; status: string }[]): Promise<Map<string, NextStep>> {
  const out = new Map<string, NextStep>()
  const ids = rows.filter(r => r.status === 'waiting_approval' || r.status === 'completed').map(r => r.runId)
  if (ids.length === 0) return out
  const types = ['node.plan_proposed', 'node.plan_decided', 'run.kept', 'run.pr_opened', 'run.merged']
  const found = await db
    .select({ runId: events.runId, type: events.type, payloadJson: events.payloadJson })
    .from(events)
    .where(and(inArray(events.runId, ids), inArray(events.type, types)))
    .orderBy(asc(events.sequence))
  const of = new Map<string, { planOpen: boolean; kept: boolean; pr: number | null; merged: boolean }>()
  const mergedPrs = new Set<number>()
  for (const e of found) {
    const m = of.get(e.runId) ?? { planOpen: false, kept: false, pr: null, merged: false }
    of.set(e.runId, m)
    if (e.type === 'node.plan_proposed') m.planOpen = true
    else if (e.type === 'node.plan_decided') m.planOpen = false
    else if (e.type === 'run.kept') m.kept = true
    else {
      const number = (JSON.parse(e.payloadJson) as { number?: unknown }).number
      if (typeof number === 'number') m.pr = number
      if (e.type === 'run.merged') {
        m.merged = true
        if (typeof number === 'number') mergedPrs.add(number)
      }
    }
  }
  for (const r of rows) {
    const m = of.get(r.runId)
    if (r.status === 'waiting_approval') out.set(r.runId, m?.planOpen ? 'plan' : 'check')
    else if (r.status === 'completed' && m) {
      // Several tasks can share one pull request (something added to a change not published yet): once it is merged,
      // all of them are published.
      if (m.merged || (m.pr !== null && mergedPrs.has(m.pr))) out.set(r.runId, 'published')
      else if (m.pr !== null) out.set(r.runId, 'publish')
      else if (m.kept) out.set(r.runId, 'send')
    }
  }
  return out
}

/** A workflow's past tasks, newest first: what was asked, when, how it ended, and the branch it was kept on. */
export async function listRuns(workflowId: string, limit = 50): Promise<RunSummary[]> {
  const rows = (await db
    .select({
      runId: runs.id,
      request: runs.request,
      status: runs.status,
      createdAt: runs.createdAt,
      branch: runs.branch,
      providerId: runs.providerId,
      parentRunId: runs.parentRunId,
      title: runs.title,
      versionId: runs.versionId,
    })
    .from(runs)
    .where(eq(runs.workflowId, workflowId))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit)
    )
  const held = await onHoldAmong(rows.map(r => r.runId))
  const onItsOwn = await passedOnItsOwnAmong(rows.map(r => r.runId))
  const next = await nextStepAmong(rows)
  const progress = await progressAmong(rows)
  const why = await whyAmong(rows)
  return rows.map(r => ({
    runId: r.runId,
    request: r.request,
    status: r.status,
    createdAt: r.createdAt,
    branch: r.branch,
    providerId: r.providerId,
    parentRunId: r.parentRunId,
    title: titleOf(r),
    onHold: held.has(r.runId),
    passedOnItsOwn: onItsOwn.has(r.runId),
    next: next.get(r.runId) ?? null,
    progress: progress.get(r.runId) ?? null,
    why: why.get(r.runId) ?? null,
  }))
}

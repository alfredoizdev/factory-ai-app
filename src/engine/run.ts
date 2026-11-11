import { baseIsStale, prepareBase } from '@/engine/base'
import { branchCommit, defaultBranch, freshestStart } from '@/engine/branches'
import { createHash } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { nodeRuns, projects, runs, workflows, workflowVersions } from '@/db/schema'
import { STAGE_ORDER, validateGraph, type Graph, type ValidationIssue } from '@/domain/graph'
import { canTransition, type NodeState } from '@/domain/states'
import { appendEventSync } from '@/engine/events'
import { isOnHold } from '@/engine/ship'
import { cleanTitle, fallbackTitle, titleOf } from '@/engine/title'
import { CLAUDE_PROVIDER_ID, DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'

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

function requireWorkflow(workflowId: string) {
  const wf = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
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
  requireWorkflow(workflowId)
  const updatedAt = db.transaction(
    tx => {
      const row = tx.select().from(workflows).where(eq(workflows.id, workflowId)).get()!
      if (base !== undefined && row.updatedAt !== base) throw new DraftConflictError()
      // Strictly later than the version replaced, even within the same millisecond, so versions never repeat.
      let stamp = now()
      if (stamp <= row.updatedAt) stamp = new Date(Date.parse(row.updatedAt) + 1).toISOString()
      tx.update(workflows).set({ draftJson: JSON.stringify(graph), updatedAt: stamp }).where(eq(workflows.id, workflowId)).run()
      return stamp
    },
    { behavior: 'immediate' },
  )
  return { issues: validateGraph(graph), updatedAt }
}

export async function publishVersion(workflowId: string): Promise<{ versionId: string; hash: string }> {
  return db.transaction(
    tx => {
      const wf = tx.select().from(workflows).where(eq(workflows.id, workflowId)).get()
      if (!wf) throw new WorkflowNotFoundError(workflowId)

      const graph = JSON.parse(wf.draftJson) as Graph
      const issues = validateGraph(graph)
      if (issues.length > 0) throw new PublishRefusedError(issues)

      const hash = hashGraph(graph)
      const latest = tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflowId))
        .orderBy(desc(sql`rowid`))
        .limit(1)
        .get()
      // Same meaning as the latest version: reuse it rather than minting a duplicate.
      if (latest && latest.hash === hash) return { versionId: latest.id, hash }

      const versionId = ulid()
      tx.insert(workflowVersions)
        .values({
          id: versionId,
          projectId: wf.projectId,
          workflowId,
          graphJson: JSON.stringify(graph),
          hash,
          createdAt: now(),
        })
        .run()
      return { versionId, hash }
    },
    { behavior: 'immediate' },
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
  /** The person's name for the task. Absent: a cut of the request, which a suggestion may improve later. */
  title?: string
}): Promise<{ runId: string; versionId: string }> {
  const wf = requireWorkflow(input.workflowId)
  const providerId = input.providerId ?? DEMO_PROVIDER_ID
  // Refused before anything is written: a real run with nowhere to work would only fail later, after a row exists.
  let baseCommit: string | null = null
  if (providerId === CLAUDE_PROVIDER_ID) {
    const project = db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, wf.projectId)).get()
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
      if (branch === main && baseIsStale(wf.projectId, baseCommit)) void prepareBase(wf.projectId)
    }
  }
  // Latest published version only. The draft is never consulted.
  const version = db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, input.workflowId))
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get()
  if (!version) throw new NothingPublishedError()

  const runId = ulid()
  // The run row and run.created commit together: a crash cannot leave a run with no events.
  db.transaction(
    tx => {
      tx.insert(runs)
        .values({
          id: runId,
          projectId: wf.projectId,
          workflowId: wf.id,
          versionId: version.id,
          status: 'queued',
          request: input.request,
          title: (input.title && cleanTitle(input.title)) || fallbackTitle(input.request),
          titleByPerson: !!(input.title && cleanTitle(input.title)),
          providerId,
          baseCommit,
          createdAt: now(),
        })
        .run()
      appendEventSync({ runId, type: 'run.created', payload: { versionId: version.id } }, tx)
      // Every block of the frozen version becomes a queued node run now (the design's section 7, step 2), so a block
      // a run never reaches can be ended as cancelled instead of reading "Queued" for ever.
      const graph = JSON.parse(version.graphJson) as Graph
      for (const kind of STAGE_ORDER) {
        for (const block of graph.blocks.filter(b => b.kind === kind)) {
          const row = tx
            .insert(nodeRuns)
            .values({ id: ulid(), projectId: wf.projectId, runId, blockId: block.id, state: 'queued', attempt: 1 })
            .returning()
            .get()
          appendEventSync({ runId, nodeRunId: row.id, type: 'node.queued', payload: { blockId: block.id } }, tx)
        }
      }
    },
    { behavior: 'immediate' },
  )
  return { runId, versionId: version.id }
}

// Persistence half only: marks the run cancelled so the durable execution function can observe it between steps
// and abort the in-flight provider. Every node that has not finished is cancelled with it, so a cancelled run never
// shows a node still running. The run row, node rows and their events commit in one transaction; a run that already
// finished is left as it is.
export async function cancelRun(runId: string): Promise<void> {
  db.transaction(
    tx => {
      const run = tx.select().from(runs).where(eq(runs.id, runId)).get()
      if (!run) throw new RunNotFoundError(runId)
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return
      const finishedAt = now()
      tx.update(runs).set({ status: 'cancelled', finishedAt }).where(eq(runs.id, runId)).run()
      for (const node of tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all()) {
        if (!canTransition(node.state as NodeState, 'cancelled')) continue
        tx.update(nodeRuns).set({ state: 'cancelled', finishedAt }).where(eq(nodeRuns.id, node.id)).run()
        appendEventSync({ runId, nodeRunId: node.id, type: 'node.cancelled', payload: { blockId: node.blockId } }, tx)
      }
      appendEventSync({ runId, type: 'run.cancelled' }, tx)
    },
    { behavior: 'immediate' },
  )
}

// For a run whose execution could not be requested: ends it as failed (status and event together) so it does not sit queued.
export async function failUnstartedRun(runId: string): Promise<void> {
  db.transaction(
    tx => {
      const run = tx.select().from(runs).where(eq(runs.id, runId)).get()
      if (!run || run.status !== 'queued') return
      tx.update(runs).set({ status: 'failed', finishedAt: now() }).where(eq(runs.id, runId)).run()
      // Nothing will ever run these blocks; leaving them queued would say they are still to come.
      for (const node of tx.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all()) {
        if (!canTransition(node.state as NodeState, 'cancelled')) continue
        tx.update(nodeRuns).set({ state: 'cancelled', finishedAt: now() }).where(eq(nodeRuns.id, node.id)).run()
        appendEventSync({ runId, nodeRunId: node.id, type: 'node.cancelled', payload: { blockId: node.blockId, reason: strings.run.couldNotStart } }, tx)
      }
      appendEventSync({ runId, type: 'run.failed', payload: { cause: 'not_started', message: strings.run.couldNotStart } }, tx)
    },
    { behavior: 'immediate' },
  )
}

export type RunSummary = {
  runId: string
  request: string
  status: string
  createdAt: string
  branch: string | null
  providerId: string
  parentRunId: string | null
  /** What the task is called: the person's name for it, or one made from its request. */
  title: string
  /** Its pull request is ready and the person put it on hold. */
  onHold: boolean
}

/** A workflow's past tasks, newest first: what was asked, when, how it ended, and the branch it was kept on. */
export function listRuns(workflowId: string, limit = 50): RunSummary[] {
  return db
    .select({
      runId: runs.id,
      request: runs.request,
      status: runs.status,
      createdAt: runs.createdAt,
      branch: runs.branch,
      providerId: runs.providerId,
      parentRunId: runs.parentRunId,
      title: runs.title,
    })
    .from(runs)
    .where(eq(runs.workflowId, workflowId))
    .orderBy(desc(sql`rowid`))
    .limit(limit)
    .all()
    .map(r => ({ ...r, title: titleOf(r), onHold: isOnHold(r.runId) }))
}

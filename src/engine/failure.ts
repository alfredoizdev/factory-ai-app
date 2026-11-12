import { existsSync } from 'node:fs'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, evidence, nodeRuns, runs, workflowVersions } from '@/db/schema'
import type { Graph } from '@/domain/graph'
import { runPlace } from '@/engine/machine'
import { DEMO_PROVIDER_ID } from '@/providers/ids'

// What went wrong in a run, for a person to read: each block that failed, what the app said about it and, when a
// command failed, what that command printed. The output was redacted when it was stored as evidence.

export type FailedBlock = {
  blockId: string
  label: string
  kind: string
  cause: string | null
  /** The sentence the canvas shows for the failure. */
  message: string | null
  /** For a failed command: what was run, how it ended and the end of what it printed. */
  command: string | null
  exitCode: number | null
  signal: string | null
  output: string | null
}

export type RunFailure = {
  status: string
  failed: FailedBlock[]
  /** True when the work the agents left can be picked up again: the run failed here, with its working copy still on disk. */
  canContinue: boolean
}

type Measured = { command?: string; exitCode?: number | null; signal?: string | null; outputTail?: string }

export async function runFailure(runId: string): Promise<RunFailure | null> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return null
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId)))[0]
  const blocks = version ? (JSON.parse(version.graphJson) as Graph).blocks : []
  const rows = await db.select().from(nodeRuns).where(and(eq(nodeRuns.runId, runId), eq(nodeRuns.state, 'failed')))
  const failed: FailedBlock[] = []
  for (const row of rows) {
    const block = blocks.find(b => b.id === row.blockId)
    const said = (await db.select().from(events).where(and(eq(events.nodeRunId, row.id), eq(events.type, 'node.failed'))).orderBy(desc(events.sequence)).limit(1))[0]
    const message = said ? ((JSON.parse(said.payloadJson) as { message?: unknown }).message ?? null) : null
    // The measurement that failed: the newest one that did not exit cleanly.
    const measured = (await db.select().from(evidence).where(eq(evidence.nodeRunId, row.id)).orderBy(desc(evidence.createdAt), desc(evidence.id)))
      .map(e => JSON.parse(e.dataJson) as Measured)
      .find(m => m.exitCode !== 0)
    failed.push({
      blockId: row.blockId,
      label: block?.label ?? row.blockId,
      kind: block?.kind ?? 'unknown',
      cause: row.failureCause,
      message: typeof message === 'string' ? message : null,
      command: measured?.command ?? null,
      exitCode: measured?.exitCode ?? null,
      signal: measured?.signal ?? null,
      output: measured?.outputTail?.trim() || null,
    })
  }
  // In the order the flow runs them.
  failed.sort((a, b) => blocks.findIndex(x => x.id === a.blockId) - blocks.findIndex(x => x.id === b.blockId))
  const here = (await runPlace(runId)).here
  const canContinue = run.status === 'failed' && run.providerId !== DEMO_PROVIDER_ID && here && !!run.baseCommit && !!run.worktreePath && existsSync(run.worktreePath)
  return { status: run.status, failed, canContinue }
}

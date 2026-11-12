import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { lockRun } from '@/engine/events'
import { approvals, nodeRuns, runs } from '@/db/schema'
import { stopPreview } from '@/engine/preview'
import { claimAttachments } from '@/engine/attachments'
import { clip, redact } from '@/engine/redact'
import { strings } from '@/ui/strings'

// The human check, guarded. A decision is a row first (who, when, which way, why, on which change), then an event.
// The executor acts on the row, never on the event alone, so a forged event opens nothing. A decision is bound to
// the change the person was shown: if the worktree changed since, it is refused.

/** 'changes': not yes, not no — send the work back to the builder, in the same worktree, with the person's note. */
export type Decision = 'approved' | 'rejected' | 'changes'

/** How many times one run can be sent back for changes before the person has to approve or turn it down. */
export const MAX_REVISIONS = 5

export class GateError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message)
    this.name = 'GateError'
  }
}

export type ChangeUnderReview = {
  /** Hash of the whole change: every changed path and its content. What an approval is bound to. */
  hash: string
  files: { path: string; added: number; removed: number }[]
  /** The diff to read, redacted and clipped. */
  diff: string
  truncated: boolean
}

const MAX_DIFF_CHARS = 60_000
/** The hash of "no change", for a run that touches no repository (the demo). */
export const NO_CHANGE = 'no-change'

/** What the run changed, read from its worktree; null when it has none. */
export async function changeUnderReview(runId: string): Promise<ChangeUnderReview | null> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run?.worktreePath || !run.baseCommit) return null
  const cwd = run.worktreePath
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  const base = run.baseCommit
  const tracked = git(['diff', base])
  const numstat = git(['diff', '--numstat', base]).split('\n').filter(Boolean).map(line => {
    const [a, r, path] = line.split('\t')
    return { path: path!, added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r) }
  })
  const known = new Set(numstat.map(f => f.path))
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(p => p && !known.has(p))
  let extra = ''
  const hash = createHash('sha256').update(tracked)
  for (const path of untracked) {
    let body = ''
    try {
      body = readFileSync(join(cwd, path), 'utf8')
    } catch {
      body = '(unreadable)'
    }
    hash.update(`\0new:${path}\0${body}`)
    extra += `\n+++ new file: ${path}\n${body.split('\n').map(l => `+${l}`).join('\n')}\n`
    numstat.push({ path, added: body.split('\n').length, removed: 0 })
  }
  const full = redact(tracked + extra)
  return { hash: hash.digest('hex'), files: numstat, diff: full.slice(0, MAX_DIFF_CHARS), truncated: full.length > MAX_DIFF_CHARS }
}

async function waitingHumanNode(runId: string) {
  return (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.state === 'waiting_approval')
}

/** Who decided. A local app has one person at the keyboard; their account name is what can honestly be recorded. */
export function localActor(): string {
  let name = 'unknown'
  try {
    name = userInfo().username
  } catch {
    // no account name available
  }
  return strings.gate.actor(name)
}

/** Writes the decision row. Exported for the executor's tests; the app goes through decideGate. */
export async function recordDecision(runId: string, decision: Decision, fields: { actor: string; reason?: string | null; diffHash: string | null }) {
  const node = (await waitingHumanNode(runId))
  if (!node) throw new GateError(strings.gate.notWaiting, 409)
  const row = {
    id: ulid(),
    projectId: node.projectId,
    runId,
    nodeRunId: node.id,
    decision,
    actor: fields.actor,
    reason: fields.reason?.trim() ? clip(redact(fields.reason.trim()), 500) : null,
    diffHash: fields.diffHash,
    createdAt: new Date().toISOString(),
  }
  await db.insert(approvals).values(row)
  return row
}

export type GateDeps = { send: (data: { runId: string; decision: Decision }) => Promise<unknown>; actor?: () => string }

/** The person's decision at a human check, as the app makes it: checked, recorded, then delivered. */
export async function decideGate(
  runId: string,
  input: { decision: Decision; reason?: string | null; diffHash: string; attachments?: readonly string[] },
  deps: GateDeps,
) {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) throw new GateError(strings.errors.runNotFound, 404)
  if (run.status !== 'waiting_approval' || !(await waitingHumanNode(runId))) throw new GateError(strings.gate.notWaiting, 409)
  if (input.decision === 'changes') {
    // A request for changes is only as good as its note: the builder has nothing else to go on.
    if (!input.reason?.trim()) throw new GateError(strings.gate.changesNeedNote, 400)
    const rounds = (await db.select().from(approvals).where(and(eq(approvals.runId, runId), eq(approvals.decision, 'changes')))).length
    if (rounds >= MAX_REVISIONS) throw new GateError(strings.gate.tooManyRounds(MAX_REVISIONS), 409)
  }
  // Bound to what was shown: approving a change nobody looked at is the gate being bypassed by timing.
  const current = (await changeUnderReview(runId))?.hash ?? NO_CHANGE
  if (input.diffHash !== current) throw new GateError(strings.gate.changedSinceSeen, 409)
  const row = (await recordDecision(runId, input.decision, { actor: (deps.actor ?? localActor)(), reason: input.reason, diffHash: current }))
  // Images sent with a request for changes go to that round only.
  if (input.decision === 'changes') (await claimAttachments(input.attachments ?? [], runId, row.id))
  try {
    await deps.send({ runId, decision: input.decision })
  } catch {
    // Not delivered, so it decided nothing: the row would claim a decision the run never received.
    await db.delete(approvals).where(eq(approvals.id, row.id))
    throw new GateError(strings.gate.notDelivered, 409)
  }
  // The decision is made; a preview of the change has nothing left to inform.
  stopPreview(runId)
  return row
}

const DECISIONS: ReadonlySet<string> = new Set<Decision>(['approved', 'rejected', 'changes'])

/**
 * The decision recorded for this human check that the run has not acted on yet, newest first, and marks it acted on.
 * Null when there is none. What the executor acts on — never the event. Each round of a run needs its own decision.
 */
export async function takeRecordedDecision(runId: string, nodeRunId: string): Promise<{ decision: Decision; note: string | null; approvalId: string } | null> {
  return db.transaction(
    async tx => {
      await lockRun(tx, runId)
      const row = (await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.runId, runId), eq(approvals.nodeRunId, nodeRunId), isNull(approvals.consumedAt)))
        .orderBy(desc(approvals.createdAt), desc(approvals.id))
        )[0]
      if (!row || !DECISIONS.has(row.decision)) return null
      await tx.update(approvals).set({ consumedAt: new Date().toISOString() }).where(eq(approvals.id, row.id))
      return { decision: row.decision as Decision, note: row.reason, approvalId: row.id }
    },
  )
}

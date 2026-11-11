import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { approvals, nodeRuns, runs } from '@/db/schema'
import { stopPreview } from '@/engine/preview'
import { clip, redact } from '@/engine/redact'
import { strings } from '@/ui/strings'

// The human check, guarded. A decision is a row first (who, when, which way, why, on which change), then an event.
// The executor acts on the row, never on the event alone, so a forged event opens nothing. A decision is bound to
// the change the person was shown: if the worktree changed since, it is refused.

export type Decision = 'approved' | 'rejected'

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
export function changeUnderReview(runId: string): ChangeUnderReview | null {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
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

function waitingHumanNode(runId: string) {
  return db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all().find(n => n.state === 'waiting_approval')
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
export function recordDecision(runId: string, decision: Decision, fields: { actor: string; reason?: string | null; diffHash: string | null }) {
  const node = waitingHumanNode(runId)
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
  db.insert(approvals).values(row).run()
  return row
}

export type GateDeps = { send: (data: { runId: string; decision: Decision }) => Promise<unknown>; actor?: () => string }

/** The person's decision at a human check, as the app makes it: checked, recorded, then delivered. */
export async function decideGate(runId: string, input: { decision: Decision; reason?: string | null; diffHash: string }, deps: GateDeps) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run) throw new GateError(strings.errors.runNotFound, 404)
  if (run.status !== 'waiting_approval' || !waitingHumanNode(runId)) throw new GateError(strings.gate.notWaiting, 409)
  // Bound to what was shown: approving a change nobody looked at is the gate being bypassed by timing.
  const current = changeUnderReview(runId)?.hash ?? NO_CHANGE
  if (input.diffHash !== current) throw new GateError(strings.gate.changedSinceSeen, 409)
  const row = recordDecision(runId, input.decision, { actor: (deps.actor ?? localActor)(), reason: input.reason, diffHash: current })
  try {
    await deps.send({ runId, decision: input.decision })
  } catch {
    // Not delivered, so it decided nothing: the row would claim a decision the run never received.
    db.delete(approvals).where(eq(approvals.id, row.id)).run()
    throw new GateError(strings.gate.notDelivered, 409)
  }
  // The decision is made; a preview of the change has nothing left to inform.
  stopPreview(runId)
  return row
}

/** The decision recorded for this human check, newest first; null when there is none. What the executor acts on. */
export function recordedDecision(runId: string, nodeRunId: string): Decision | null {
  const row = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.nodeRunId, nodeRunId)))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .get()
  return row?.decision === 'approved' || row?.decision === 'rejected' ? row.decision : null
}

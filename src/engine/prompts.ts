import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { approvals, events, runs } from '@/db/schema'

// Everything that was asked of the agents on one task, in order: the request, every new plan and every change the
// person asked for, and what a reviewer sent back. Each says who asked. What a decision said goes with it too.

export type PromptKind = 'request' | 'followUp' | 'memory' | 'replan' | 'changes' | 'reviewer' | 'approvedNote' | 'rejectedNote'
export type Prompt = {
  kind: PromptKind
  text: string
  at: string
  /** Asked on an earlier task this one continues from: context for this one, shown where it starts. */
  earlier?: boolean
}

/** Everything asked on this task and, before it, on each earlier task it continues from (oldest first). */
export async function promptsOf(runId: string): Promise<Prompt[]> {
  const own = (await promptsOfOne(runId))
  const earlier: Prompt[] = []
  let parent = (await db.select({ p: runs.parentRunId }).from(runs).where(eq(runs.id, runId)))[0]?.p ?? null
  for (let depth = 0; parent && depth < 20; depth++) {
    earlier.unshift(...(await promptsOfOne(parent)).map(p => ({ ...p, earlier: true })))
    parent = (await db.select({ p: runs.parentRunId }).from(runs).where(eq(runs.id, parent)))[0]?.p ?? null
  }
  return [...earlier, ...own]
}

async function promptsOfOne(runId: string): Promise<Prompt[]> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) return []
  const out: Prompt[] = [{ kind: run.parentRunId ? 'followUp' : 'request', text: run.request, at: run.createdAt }]
  const rounds = new Set<string>()
  // The plan's own node: asking for a new plan reopens it too, but that is already said once, as a new plan.
  const planNodes = new Set<string>()
  for (const e of (await db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.sequence)))) {
    const p = JSON.parse(e.payloadJson) as Record<string, unknown>
    const text = typeof p.note === 'string' ? p.note.trim() : ''
    // The project's rules the task was given: the agent read them with the request.
    if (e.type === 'run.memory' && Array.isArray(p.notes) && p.notes.length > 0) {
      out.push({ kind: 'memory', text: (p.notes as unknown[]).filter((n): n is string => typeof n === 'string').map(n => `• ${n}`).join('\n'), at: e.createdAt })
    }
    if (e.type === 'node.plan_decided' && e.nodeRunId) planNodes.add(e.nodeRunId)
    if (e.type === 'node.plan_decided' && p.action === 'replan' && text) out.push({ kind: 'replan', text, at: e.createdAt })
    // One reopen event per reopened block: the note is taken once, from the first block of the round.
    const round = `${String(p.by)}-${String(p.round)}`
    if (e.type === 'node.reopened' && p.by !== 'fixes' && text && !rounds.has(round) && !(e.nodeRunId && planNodes.has(e.nodeRunId))) {
      rounds.add(round)
      out.push({ kind: p.by === 'reviewer' ? 'reviewer' : 'changes', text, at: e.createdAt })
    }
  }
  // A yes or a no with a note: what the person said when deciding.
  for (const a of (await db.select().from(approvals).where(eq(approvals.runId, runId)))) {
    const text = a.reason?.trim()
    if (!text || a.decision === 'changes') continue
    out.push({ kind: a.decision === 'approved' ? 'approvedNote' : 'rejectedNote', text, at: a.createdAt })
  }
  return out.sort((x, y) => x.at.localeCompare(y.at))
}

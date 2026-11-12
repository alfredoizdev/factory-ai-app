import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { findings, nodeRuns, runs } from '@/db/schema'
import { appendEventSync } from '@/engine/events'
import type { Repro, ReproRun } from '@/engine/repro'
import { label, touchesCore } from '@/engine/register'
import type { Finding, Focus, Severity } from '@/engine/review'
import { SENSITIVE } from '@/engine/risk'
import { strings } from '@/ui/strings'

// What reviewers report is a claim. Before anyone acts on it the app checks, without a model, that what it points at
// exists in the task's working copy; duplicates from several reviewers become one; the rest is ordered and given a risk.

export type { Repro, ReproRun }
export type FindingState = 'reported' | 'refuted' | 'unbacked' | 'confirmed' | 'asked' | 'corrected' | 'fixed_unchecked' | 'discarded' | 'open'
export type FindingRow = Finding & {
  id: string
  runId: string
  projectId: string
  round: number
  reporters: Focus[]
  count: number
  state: FindingState
  reason: string | null
  repro: Repro | null
  evidence: ReproRun | null
  entryNumber: number | null
}

/** Findings this close together (in lines), in one file and of one type, are the same problem. */
export const DUPLICATE_WINDOW = 3

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** Whether the file and line a finding cites exist in the working copy. Never reads outside it, symlinks included. */
export function citeCheck(workdir: string, f: Finding): { ok: true } | { ok: false; reason: string } {
  if (!f.file) return { ok: true }
  const outside = { ok: false as const, reason: strings.findings.outsideCopy }
  const missing = { ok: false as const, reason: strings.findings.noSuchFile }
  const inside = (root: string, p: string) => {
    const rel = relative(root, p)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  let root: string
  try {
    root = realpathSync(workdir)
  } catch {
    return missing
  }
  const wanted = resolve(root, f.file)
  if (!inside(root, wanted)) return outside
  let real: string
  try {
    real = realpathSync(wanted)
  } catch {
    return missing
  }
  if (!inside(root, real)) return outside
  if (f.line === undefined) {
    try {
      readFileSync(real)
    } catch {
      return missing
    }
    return { ok: true }
  }
  let text: string
  try {
    text = readFileSync(real, 'utf8')
  } catch {
    return missing
  }
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines) return { ok: false, reason: strings.findings.noSuchLine }
  return { ok: true }
}

type Merged = { finding: Finding; reporters: Focus[]; count: number }

/** One finding per problem: same type and file, lines within DUPLICATE_WINDOW. Keeps the higher severity and the longer text. */
export function mergeDuplicates(found: { focus: Focus; finding: Finding }[]): Merged[] {
  const out: Merged[] = []
  for (const { focus, finding } of found) {
    const same = out.find(
      m =>
        m.finding.type === finding.type &&
        m.finding.file !== undefined &&
        m.finding.file === finding.file &&
        m.finding.line !== undefined &&
        finding.line !== undefined &&
        Math.abs(m.finding.line - finding.line) <= DUPLICATE_WINDOW,
    )
    if (!same) {
      out.push({ finding: { ...finding, affects: [...finding.affects], decisions: [...finding.decisions] }, reporters: [focus], count: 1 })
      continue
    }
    const kept = same.finding
    same.finding = {
      ...kept,
      line: Math.min(kept.line!, finding.line!),
      problem: finding.problem.length > kept.problem.length ? finding.problem : kept.problem,
      severity: RANK[finding.severity] < RANK[kept.severity] ? finding.severity : kept.severity,
      affects: [...new Set([...kept.affects, ...finding.affects])],
      decisions: [...new Set([...kept.decisions, ...finding.decisions])],
    }
    if (!same.reporters.includes(focus)) same.reporters.push(focus)
    same.count += 1
  }
  return out
}

/** High first, then medium, then low; the reported order is kept within one severity. */
export function bySeverity<T extends { severity: Severity }>(items: T[]): T[] {
  return items.map((item, i) => ({ item, i })).sort((a, b) => RANK[a.item.severity] - RANK[b.item.severity] || a.i - b.i).map(x => x.item)
}

/** High when the problem is in a core or sensitive area, touches a decision, is a serious security problem, or is unclear; every reason is given. */
export function riskOf(f: Finding, ctx: { corePaths: string[]; unknown?: boolean }): { level: 'low' | 'high'; reasons: string[] } {
  const reasons: string[] = []
  if (f.file && touchesCore(f.file, ctx.corePaths)) reasons.push(strings.findings.risk.core)
  const area = f.file ? SENSITIVE.find(([re]) => re.test(f.file!)) : undefined
  if (area) reasons.push(strings.findings.risk.sensitive(area[1]))
  for (const n of f.decisions) reasons.push(strings.findings.risk.decision(label(n)))
  if (f.type === 'security' && f.severity === 'high') reasons.push(strings.findings.risk.security)
  if (ctx.unknown) reasons.push(strings.findings.risk.unknown)
  return { level: reasons.length > 0 ? 'high' : 'low', reasons }
}

function toRow(r: typeof findings.$inferSelect): FindingRow {
  return {
    id: r.id,
    runId: r.runId,
    projectId: r.projectId,
    round: r.round,
    type: r.type as FindingRow['type'],
    ...(r.file !== null ? { file: r.file } : {}),
    ...(r.line !== null ? { line: r.line } : {}),
    problem: r.problem,
    severity: r.severity as Severity,
    affects: JSON.parse(r.affectsJson) as string[],
    decisions: JSON.parse(r.decisionsJson) as number[],
    reporters: JSON.parse(r.reportersJson) as Focus[],
    count: r.count,
    state: r.state as FindingState,
    reason: r.reason,
    repro: r.reproJson ? (JSON.parse(r.reproJson) as Repro) : null,
    evidence: r.evidenceJson ? (JSON.parse(r.evidenceJson) as ReproRun) : null,
    entryNumber: r.entryNumber,
  }
}

/** Checks each merged finding against the working copy and records them (refuted ones with the reason) with one event, together. The event's "merged" is how many reports were folded into another. */
export async function recordFindings(runId: string, nodeRunId: string, round: number, merged: Merged[], workdir: string): Promise<FindingRow[]> {
  const checked = merged.map(m => ({ m, check: citeCheck(workdir, m.finding) }))
  const at = new Date().toISOString()
  return db.transaction(async tx => {
    const run = (await tx.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId)))[0]
    if (!run) throw new Error(`Cannot record findings: run ${runId} does not exist`)
    const node = (await tx.select({ blockId: nodeRuns.blockId }).from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]
    if (!node) throw new Error(`Cannot record findings: node run ${nodeRunId} does not exist`)
    const rows: FindingRow[] = []
    for (const { m, check } of checked) {
      const f = m.finding
      const inserted = await tx
        .insert(findings)
        .values({
          id: ulid(),
          projectId: run.projectId,
          runId,
          round,
          type: f.type,
          file: f.file ?? null,
          line: f.line ?? null,
          problem: f.problem,
          severity: f.severity,
          affectsJson: JSON.stringify(f.affects),
          decisionsJson: JSON.stringify(f.decisions),
          reportersJson: JSON.stringify(m.reporters),
          count: m.count,
          state: check.ok ? 'reported' : 'refuted',
          reason: check.ok ? null : check.reason,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
      rows.push(toRow(inserted[0]!))
    }
    const refuted = rows.filter(r => r.state === 'refuted').length
    await appendEventSync(
      { runId, nodeRunId, type: 'node.findings_checked', payload: { blockId: node.blockId, round, reported: rows.length - refuted, refuted, merged: merged.reduce((n, m) => n + m.count - 1, 0) } },
      tx,
    )
    return rows
  })
}

export async function setFinding(id: string, change: Partial<Pick<FindingRow, 'state' | 'reason' | 'repro' | 'evidence' | 'entryNumber'>>): Promise<void> {
  const set: Partial<typeof findings.$inferInsert> = { updatedAt: new Date().toISOString() }
  if (change.state !== undefined) set.state = change.state
  if (change.reason !== undefined) set.reason = change.reason
  if (change.repro !== undefined) set.reproJson = change.repro === null ? null : JSON.stringify(change.repro)
  if (change.evidence !== undefined) set.evidenceJson = change.evidence === null ? null : JSON.stringify(change.evidence)
  if (change.entryNumber !== undefined) set.entryNumber = change.entryNumber
  await db.update(findings).set(set).where(eq(findings.id, id))
}

export async function findingsOf(runId: string): Promise<FindingRow[]> {
  return (await db.select().from(findings).where(eq(findings.runId, runId)).orderBy(asc(findings.createdAt), asc(findings.id))).map(toRow)
}

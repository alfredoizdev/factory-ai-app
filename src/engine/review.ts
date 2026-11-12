
// What a reviewer says about a change, as data. The reviewer is a model, so all of this is its claim: it is shown as
// "AI says", never as a measurement. It is read from a small JSON object the reviewer is asked to end with; anything
// that is not that object is not turned into a verdict.

export type Focus = 'logic' | 'security' | 'effects'
export const FOCUSES: readonly Focus[] = ['logic', 'security', 'effects']
export type FindingType = 'logic' | 'security' | 'effect'
export type Severity = 'high' | 'medium' | 'low'
export type Finding = {
  type: FindingType
  file?: string
  line?: number
  problem: string
  severity: Severity
  /** What else the problem touches, in the reviewer's words. */
  affects: string[]
  /** Numbers of the project's decisions the change touches. */
  decisions: number[]
}
export type Review = { verdict: 'ok' | 'changes'; findings: Finding[] }

export const MAX_FINDINGS = 10
const MAX_PROBLEM = 300
const MAX_AFFECTS = 5
const MAX_AFFECT = 80

/** A small change gets one reviewer on the logic; a risky one gets one for each focus. */
export function focusesFor(risk: 'low' | 'high'): Focus[] {
  return risk === 'high' ? [...FOCUSES] : ['logic']
}

/** The reviewer's verdict and findings, from the last JSON object in its answer; null when there is none. */
export function parseReview(text: string): Review | null {
  const candidates = [...text.matchAll(/\{[\s\S]*?"verdict"[\s\S]*\}/g)].map(m => m[0])
  for (const raw of candidates.reverse()) {
    // The greedy match may run past the object's end into later text: try shorter endings until one parses.
    for (let end = raw.length; end > 0; end = raw.lastIndexOf('}', end - 1)) {
      try {
        const value = JSON.parse(raw.slice(0, end + (raw[end] === '}' ? 1 : 0))) as { verdict?: unknown; findings?: unknown }
        const review = validReview(value)
        if (review) return review
      } catch {
        // not this ending
      }
      if (end <= 0) break
    }
  }
  return null
}

function validReview(value: { verdict?: unknown; findings?: unknown }): Review | null {
  if (value.verdict !== 'ok' && value.verdict !== 'changes') return null
  const raw = Array.isArray(value.findings) ? value.findings : []
  const findings: Finding[] = []
  for (const f of raw.slice(0, MAX_FINDINGS) as { type?: unknown; file?: unknown; line?: unknown; problem?: unknown; severity?: unknown; affects?: unknown; decisions?: unknown }[]) {
    if (typeof f?.problem !== 'string' || f.problem.trim() === '') continue
    findings.push({
      type: f.type === 'security' || f.type === 'effect' ? f.type : 'logic',
      severity: f.severity === 'high' || f.severity === 'low' ? f.severity : 'medium',
      affects: Array.isArray(f.affects) ? f.affects.filter((a): a is string => typeof a === 'string' && a.trim() !== '').slice(0, MAX_AFFECTS).map(a => a.trim().slice(0, MAX_AFFECT)) : [],
      decisions: Array.isArray(f.decisions) ? f.decisions.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0) : [],
      problem: f.problem.trim().slice(0, MAX_PROBLEM),
      ...(typeof f.file === 'string' && f.file.trim() !== '' ? { file: f.file.trim().slice(0, 200) } : {}),
      ...(typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? { line: f.line } : {}),
    })
  }
  // "changes" with nothing to change is no verdict at all: there would be nothing to send back.
  if (value.verdict === 'changes' && findings.length === 0) return null
  return { verdict: value.verdict, findings: value.verdict === 'ok' ? [] : findings }
}

/** Where a finding is, as a person reads it: "src/app/page.tsx:15", or nothing. */
export function whereOf(f: Finding): string {
  return f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''
}

/** A reviewer other than the builder: a second opinion from the same model tends to agree with itself. */
export function defaultReviewerModel(buildModel?: string): string {
  return buildModel?.toLowerCase().includes('sonnet') ? 'opus' : 'sonnet'
}

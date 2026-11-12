// What a reviewer says about a change, as data. The reviewer is a model, so all of this is its claim: it is shown as
// "AI says", never as a measurement. It is read from a small JSON object the reviewer is asked to end with; anything
// that is not that object is not turned into a verdict.

import { jsonObjectsFromEnd } from '@/engine/json-objects'

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
/** How many times the change is read between two decisions of the person: the first review and one more after fixes. The checks run again after fixes at most as often. */
export const MAX_REVIEW_ROUNDS = 2
const MAX_PROBLEM = 300
const MAX_AFFECTS = 5
/** How many decision numbers one finding may name. */
const MAX_DECISIONS = 5
const MAX_AFFECT = 80

/** A small change gets one reviewer on the logic; a risky one gets one for each focus. */
export function focusesFor(risk: 'low' | 'high'): Focus[] {
  return risk === 'high' ? [...FOCUSES] : ['logic']
}

/** Why an answer is no verdict: no JSON object in it, no object with a verdict, or "changes" with nothing to change. */
export type UnreadableReview = 'no_json' | 'no_verdict' | 'changes_without_findings'

/** The reviewer's verdict and findings, from the last JSON object with a verdict in its answer; null when there is none. */
export function parseReview(text: string): Review | null {
  const checked = checkReview(text)
  return 'review' in checked ? checked.review : null
}

/** The verdict, or why there is none. Prose, code with braces or a code fence around the object do not matter. */
export function checkReview(text: string): { review: Review } | { why: UnreadableReview } {
  const objects = jsonObjectsFromEnd(text)
  if (objects.length === 0) return { why: 'no_json' }
  let why: UnreadableReview = 'no_verdict'
  for (const value of objects) {
    const review = validReview(value)
    if (review) return { review }
    if (value.verdict === 'changes') why = 'changes_without_findings'
  }
  return { why }
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
      // Each number once, and a few at most: each becomes a sentence in the question about it.
      decisions: Array.isArray(f.decisions) ? [...new Set(f.decisions.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0))].slice(0, MAX_DECISIONS) : [],
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

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strings } from '@/ui/strings'

// Whether a run's change is small and safe enough that the person chose not to be asked. Decided from what the
// change measurably is — which files, how many lines, whether the tests ran, passed and were left alone — never
// from what the agent says about it. Anything that cannot be measured counts as high risk.

export const MAX_LOW_RISK_FILES = 8
export const MAX_LOW_RISK_LINES = 300

export type ChangedFile = { path: string; lines: number }
export type TestFacts = {
  testsRan: boolean
  testsPassed: boolean
  testsChanged: boolean
  /** A problem the reviewers found is still open (not dealt with, or waiting on the person). */
  reviewOpen?: boolean
  /** A problem was fixed, but the app could not check the fix. */
  reviewUnchecked?: boolean
  /** In the latest review, a reviewer's answer could not be read: that part of the review is missing. */
  reviewUnreadable?: boolean
}
export type RiskAssessment = { level: 'low' | 'high'; reasons: string[]; files: string[]; linesChanged: number }

/** Files that hold private settings: .env files and anything named like a secret or credential. */
export const SECRET_FILES = /(^|\/)\.env(\.|$)|secret|credential/i

// Areas where a wrong change is expensive. Matched on the path, case-insensitively.
export const SENSITIVE: readonly [RegExp, string][] = [
  [SECRET_FILES, strings.risk.areas.secrets],
  [/auth|login|logout|sign-?in|sign-?up|session|password|oauth|jwt|token/i, strings.risk.areas.auth],
  [/payment|billing|stripe|checkout|invoice|subscription|paypal|price|pricing/i, strings.risk.areas.payments],
  [/migration|(^|\/)(prisma|supabase|drizzle|db|database)\/|schema\.(prisma|sql|ts)$|\.sql$/i, strings.risk.areas.database],
  [/(^|\/)(api|server|actions)\/|(^|\/)(middleware|proxy)\.[jt]s$|route\.[jt]sx?$/i, strings.risk.areas.server],
  [/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json)$|\.config\.[cm]?[jt]s$|(^|\/)\.[a-z]+rc(\.[a-z]+)?$/i, strings.risk.areas.config],
  [/(^|\/)(\.github|\.gitlab|\.circleci)\/|(^|\/)(dockerfile|docker-compose[^/]*|vercel\.json|vercel\.ts|fly\.toml|netlify\.toml|render\.yaml|procfile)$/i, strings.risk.areas.deploy],
]

/** How many core areas a change is told apart by; past that, how many more is said in one line. */
export const MAX_CORE_REASONS = 5

/** A core-area pattern ending in "/" is a folder and everything beneath it; any other pattern is that exact file. */
export function insideCoreArea(path: string, pattern: string): boolean {
  return pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern
}

/** One reason per core area the files fall in, naming the first file there and how many others. */
function coreReasons(files: readonly ChangedFile[], core: readonly string[]): string[] {
  const hits = [...new Set(core)].flatMap(area => {
    const inside = files.filter(f => insideCoreArea(f.path, area))
    return inside.length > 0 ? [strings.risk.insideCore(inside[0]!.path, area, inside.length - 1)] : []
  })
  return hits.length > MAX_CORE_REASONS ? [...hits.slice(0, MAX_CORE_REASONS), strings.risk.moreCore(hits.length - MAX_CORE_REASONS)] : hits
}

/** A decision of the person's, with the files or folders it names (a folder ends in "/"). */
export type DecisionPaths = { text: string; paths: readonly string[] }

/** One reason per decision that names a changed file, saying which file and which decision. */
function decisionReasons(files: readonly ChangedFile[], decisions: readonly DecisionPaths[]): string[] {
  const hits = decisions.flatMap(d => {
    const first = files.find(f => d.paths.some(p => insideCoreArea(f.path, p)))
    return first ? [strings.risk.onDecision(first.path, d.text)] : []
  })
  return hits.length > MAX_CORE_REASONS ? [...hits.slice(0, MAX_CORE_REASONS), strings.risk.moreDecisions(hits.length - MAX_CORE_REASONS)] : hits
}

/**
 * `core`: the project's core areas that are switched on; a change inside one always needs the person.
 * `decisions`: the person's decisions that name files; a change on one of those files needs them too.
 */
export function classifyChange(files: readonly ChangedFile[], tests: TestFacts, core: readonly string[] = [], decisions: readonly DecisionPaths[] = []): RiskAssessment {
  const reasons: string[] = []
  const linesChanged = files.reduce((n, f) => n + f.lines, 0)
  if (files.length === 0) reasons.push(strings.risk.nothingChanged)
  reasons.push(...coreReasons(files, core))
  reasons.push(...decisionReasons(files, decisions))
  for (const f of files) {
    const hit = SENSITIVE.find(([re]) => re.test(f.path))
    if (hit) reasons.push(strings.risk.touches(f.path, hit[1]))
  }
  if (files.length > MAX_LOW_RISK_FILES) reasons.push(strings.risk.tooManyFiles(files.length, MAX_LOW_RISK_FILES))
  if (linesChanged > MAX_LOW_RISK_LINES) reasons.push(strings.risk.tooManyLines(linesChanged, MAX_LOW_RISK_LINES))
  if (!tests.testsRan) reasons.push(strings.risk.noTests)
  else if (!tests.testsPassed) reasons.push(strings.risk.testsFailed)
  if (tests.testsChanged) reasons.push(strings.risk.testsChanged)
  if (tests.reviewOpen) reasons.push(strings.risk.reviewStillOpen)
  if (tests.reviewUnchecked) reasons.push(strings.risk.fixUnchecked)
  if (tests.reviewUnreadable) reasons.push(strings.risk.reviewUnreadable)
  const level = reasons.length === 0 ? 'low' : 'high'
  return { level, reasons: level === 'low' ? [strings.risk.lowBecause(files.length, linesChanged)] : reasons, files: files.map(f => f.path), linesChanged }
}

function changedFiles(workdir: string, baseCommit: string): ChangedFile[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const counted = git(['diff', '--numstat', baseCommit])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [added, removed, path] = line.split('\t')
      // A binary file reports "-": count it as one line so it is not invisible.
      const n = (v: string | undefined) => (v === undefined || v === '-' ? 1 : Number(v))
      return { path: path!, lines: n(added) + n(removed) }
    })
  const known = new Set(counted.map(f => f.path))
  const added = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(p => p && !known.has(p))
    .map(path => {
      let lines = 1
      try {
        lines = Math.max(1, readFileSync(join(workdir, path), 'utf8').split('\n').length)
      } catch {
        // unreadable: still counted as a change
      }
      return { path, lines }
    })
  return [...counted, ...added]
}

export function assessRisk(workdir: string, baseCommit: string, tests: TestFacts, core: readonly string[] = [], decisions: readonly DecisionPaths[] = []): RiskAssessment {
  try {
    return classifyChange(changedFiles(workdir, baseCommit), tests, core, decisions)
  } catch {
    return { level: 'high', reasons: [strings.risk.unreadable], files: [], linesChanged: 0 }
  }
}

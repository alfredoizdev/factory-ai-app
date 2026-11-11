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
export type TestFacts = { testsRan: boolean; testsPassed: boolean; testsChanged: boolean }
export type RiskAssessment = { level: 'low' | 'high'; reasons: string[]; files: string[]; linesChanged: number }

// Areas where a wrong change is expensive. Matched on the path, case-insensitively.
const SENSITIVE: readonly [RegExp, string][] = [
  [/(^|\/)\.env(\.|$)|secret|credential/i, strings.risk.areas.secrets],
  [/auth|login|logout|sign-?in|sign-?up|session|password|oauth|jwt|token/i, strings.risk.areas.auth],
  [/payment|billing|stripe|checkout|invoice|subscription|paypal|price|pricing/i, strings.risk.areas.payments],
  [/migration|(^|\/)(prisma|supabase|drizzle|db|database)\/|schema\.(prisma|sql|ts)$|\.sql$/i, strings.risk.areas.database],
  [/(^|\/)(api|server|actions)\/|(^|\/)(middleware|proxy)\.[jt]s$|route\.[jt]sx?$/i, strings.risk.areas.server],
  [/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json)$|\.config\.[cm]?[jt]s$|(^|\/)\.[a-z]+rc(\.[a-z]+)?$/i, strings.risk.areas.config],
  [/(^|\/)(\.github|\.gitlab|\.circleci)\/|(^|\/)(dockerfile|docker-compose[^/]*|vercel\.json|vercel\.ts|fly\.toml|netlify\.toml|render\.yaml|procfile)$/i, strings.risk.areas.deploy],
]

export function classifyChange(files: readonly ChangedFile[], tests: TestFacts): RiskAssessment {
  const reasons: string[] = []
  const linesChanged = files.reduce((n, f) => n + f.lines, 0)
  if (files.length === 0) reasons.push(strings.risk.nothingChanged)
  for (const f of files) {
    const hit = SENSITIVE.find(([re]) => re.test(f.path))
    if (hit) reasons.push(strings.risk.touches(f.path, hit[1]))
  }
  if (files.length > MAX_LOW_RISK_FILES) reasons.push(strings.risk.tooManyFiles(files.length, MAX_LOW_RISK_FILES))
  if (linesChanged > MAX_LOW_RISK_LINES) reasons.push(strings.risk.tooManyLines(linesChanged, MAX_LOW_RISK_LINES))
  if (!tests.testsRan) reasons.push(strings.risk.noTests)
  else if (!tests.testsPassed) reasons.push(strings.risk.testsFailed)
  if (tests.testsChanged) reasons.push(strings.risk.testsChanged)
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

export function assessRisk(workdir: string, baseCommit: string, tests: TestFacts): RiskAssessment {
  try {
    return classifyChange(changedFiles(workdir, baseCommit), tests)
  } catch {
    return { level: 'high', reasons: [strings.risk.unreadable], files: [], linesChanged: 0 }
  }
}

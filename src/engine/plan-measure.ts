import type { Job, PlanQuestion } from '@/engine/plan'
import { insideCoreArea, SENSITIVE } from '@/engine/risk'
import { strings } from '@/ui/strings'

// Whether a plan is simple enough to start without asking the person, judged only from the files and folders the
// planner says it expects to change. Pure: no database, no files, no provider. A change that turns out bigger is
// still caught afterwards by classifyChange.

export const MAX_PLAN_ENTRIES = 8
export type PlanVerdict = { simple: boolean; reasons: string[]; entries: string[] }

const r = strings.plan.reasons

/** True when one pattern covers the other: equal, or a folder ("x/") that the other lies inside, either way. */
export function pathsOverlap(a: string, b: string): boolean {
  return insideCoreArea(a, b) || insideCoreArea(b, a)
}

function unmeasurable(p: string): boolean {
  return p === '' || p === '.' || p === './' || p.startsWith('/') || /[*?[\]{}]/.test(p) || p.split('/').includes('..')
}

function tooWide(p: string): boolean {
  return p.endsWith('/') && p.split('/').filter(Boolean).length < 2
}

/** The sensitive area a planned path falls in. A folder is judged by its own path, the way a file inside it would be:
 *  a folder that merely contains a sensitive folder deeper down cannot be seen from here. */
function sensitiveArea(p: string): string | undefined {
  return SENSITIVE.find(([re]) => re.test(p))?.[1]
}

export function measurePlan(
  answer: { jobs: readonly Job[]; question: PlanQuestion | 'unreadable' | null },
  register: { core: readonly string[]; decisions: readonly { text: string; paths: readonly string[] }[] },
): PlanVerdict {
  const entries = [...new Set(answer.jobs.flatMap(j => j.paths ?? []))]
  const reasons: string[] = []
  if (answer.question === 'unreadable') reasons.push(r.questionUnreadable)
  else if (answer.question) reasons.push(r.asks)

  if (entries.length === 0 || answer.jobs.some(j => j.paths === undefined)) reasons.push(r.noPaths)

  const measurable = entries.filter(p => !unmeasurable(p))
  for (const p of entries) if (unmeasurable(p)) reasons.push(r.unmeasurable(p))
  for (const p of measurable) if (tooWide(p)) reasons.push(r.tooWide(p))

  const areas = new Set<string>()
  for (const p of measurable) {
    const area = sensitiveArea(p)
    if (area) areas.add(area)
  }
  for (const area of areas) reasons.push(r.sensitive(area))

  if (measurable.some(p => register.core.some(c => pathsOverlap(p, c)))) reasons.push(r.core)
  for (const d of register.decisions) {
    if (d.paths.some(dp => measurable.some(p => pathsOverlap(p, dp)))) reasons.push(r.decision(d.text))
  }
  if (entries.length > MAX_PLAN_ENTRIES) reasons.push(r.tooMany(entries.length, MAX_PLAN_ENTRIES))

  return reasons.length === 0 ? { simple: true, reasons: [r.simple(entries.length)], entries } : { simple: false, reasons, entries }
}

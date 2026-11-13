import type { Job, PlanQuestion } from '@/engine/plan'
import { insideCoreArea, SENSITIVE } from '@/engine/risk'
import { strings } from '@/ui/strings'

// Whether a plan is simple enough to start without asking the person, judged only from the files and folders the
// planner says it expects to change. Pure: no database, no files, no provider. A change that turns out bigger is
// still caught afterwards by classifyChange.

export const MAX_PLAN_ENTRIES = 8
export type PlanVerdict = { simple: boolean; reasons: string[]; entries: string[] }

const r = strings.plan.reasons

/** True when one pattern covers the other: equal, or a folder ("x/") that the other lies inside, either way.
 *  Compared without regard to case, as the sensitive areas are. */
export function pathsOverlap(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return insideCoreArea(x, y) || insideCoreArea(y, x)
}

const ROUTE_VALUE = /^\[(\[\.\.\.[\w-]+\]|(\.\.\.)?[\w-]+)\](\.[a-z0-9]+)*$/i

function unmeasurable(p: string): boolean {
  if (p === '' || p === '.' || p === './' || p.startsWith('/') || p.startsWith('~') || /^[a-z]:/i.test(p)) return true
  if (/[*?{}\\]/.test(p) || /[\u0000-\u001f\u007f]/.test(p)) return true
  // Square brackets are a pattern, except as a whole folder or file name the way Next.js writes a page that takes a
  // value: "[team]", "[...slug]", "[[...slug]]", "[id].tsx". Those are real names and are read as they are.
  const segs = (p.endsWith('/') ? p.slice(0, -1) : p).split('/')
  if (segs.some(seg => /[[\]]/.test(seg) && !ROUTE_VALUE.test(seg))) return true
  return segs.some(seg => seg === '' || seg === '.' || seg === '..' || seg !== seg.trim())
}

/** The app cannot tell a file from a folder written without its slash, so such an entry is read both ways. */
function readings(p: string): string[] {
  return p.endsWith('/') ? [p] : [p, `${p}/`]
}

/** A folder with fewer than two segments. A lone name with no slash and an extension ("package.json") is taken as a file. */
function tooWide(p: string): boolean {
  if (p.split('/').filter(Boolean).length >= 2) return false
  return p.endsWith('/') || !/[^.]\.[a-z0-9]+$/i.test(p)
}
/** A lone name at the top with no slash and no extension ("Makefile", "src"): a file or a whole folder, the app cannot tell. */
const lonely = (p: string) => !p.endsWith('/')

/** The sensitive area a planned path falls in. A folder is judged by its own path, the way a file inside it would be:
 *  a folder that merely contains a sensitive folder deeper down cannot be seen from here. */
function sensitiveArea(p: string): string | undefined {
  return SENSITIVE.find(([re]) => re.test(p))?.[1]
}

export function measurePlan(
  answer: { jobs: readonly Job[]; question: PlanQuestion | 'unreadable' | null },
  register: { core: readonly string[]; decisions: readonly { text: string; paths: readonly string[] }[] },
): PlanVerdict {
  // "src/x" and "src/x/" are one entry; the first spelling is kept.
  const seen = new Set<string>()
  const entries = answer.jobs.flatMap(j => j.paths ?? []).filter(p => {
    const key = p.endsWith('/') ? p.slice(0, -1) : p
    return !seen.has(key) && !!seen.add(key)
  })
  // The most useful reason first, as the card leads with it: the question, what the change would touch, then what
  // could not be measured, then its size. No reason names a path: the paths are listed under the plan already.
  const reasons: string[] = []
  if (answer.question === 'unreadable') reasons.push(r.questionUnreadable)
  else if (answer.question) reasons.push(r.asks)

  const measurable = entries.filter(p => !unmeasurable(p))
  const areas = new Set<string>()
  for (const p of measurable) {
    for (const q of readings(p)) {
      const area = sensitiveArea(q)
      if (area) areas.add(area)
    }
  }
  for (const area of areas) reasons.push(r.sensitive(area))

  if (measurable.some(p => readings(p).some(q => register.core.some(c => pathsOverlap(q, c))))) reasons.push(r.core)
  for (const d of register.decisions) {
    if (d.paths.some(dp => measurable.some(p => readings(p).some(q => pathsOverlap(q, dp))))) reasons.push(r.decision(d.text))
  }
  if (entries.length === 0 || answer.jobs.some(j => j.paths === undefined)) reasons.push(r.noPaths)
  if (entries.some(unmeasurable)) reasons.push(r.unmeasurable)
  const wide = measurable.filter(tooWide)
  if (wide.some(p => !lonely(p))) reasons.push(r.tooWide)
  if (wide.some(lonely)) reasons.push(r.rootName)
  if (entries.length > MAX_PLAN_ENTRIES) reasons.push(r.tooMany(entries.length, MAX_PLAN_ENTRIES))

  return reasons.length === 0 ? { simple: true, reasons: [r.simple(entries.length)], entries } : { simple: false, reasons, entries }
}

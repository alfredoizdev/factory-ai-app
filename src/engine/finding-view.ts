import { endingOf, latestOf, type Ending, type FindingRow } from '@/engine/findings'
import { clip, redact } from '@/engine/redact'
import { reproduced } from '@/engine/repro'
import { whereOf } from '@/engine/review'
import { strings } from '@/ui/strings'

// What the list on the screen is made from: one entry per problem, with a plain sentence on the first level and the
// technical part (the reviewer's own words, the command and what it printed) apart, redacted, for "See details".

/** What an ending rests on: 'checked' is something the app ran or looked up itself; 'ai' is only what an AI said; 'not_checked' is that nothing could be run. */
export type How = 'checked' | 'ai' | 'not_checked'

export type FindingView = {
  id: string
  title: string
  type: FindingRow['type']
  state: FindingRow['state']
  ending: Ending
  /** How it ended, in one plain sentence. */
  outcome: string
  how: How
  detail: { where: string; problem: string; command: string; outputTail: string; reason: string }
}

const CITE_REASONS: readonly string[] = [strings.findings.noSuchFile, strings.findings.noSuchLine, strings.findings.outsideCopy]
/** The cite check is the app's own look at the working copy; a refutation by it carries one of these reasons. */
const citeRefuted = (row: Pick<FindingRow, 'state' | 'reason'>) => row.state === 'refuted' && row.reason !== null && CITE_REASONS.includes(row.reason)
/** The app ran the reproduction itself and saw the problem happen. */
const shown = (row: Pick<FindingRow, 'repro' | 'evidence'>) => row.repro !== null && row.evidence !== null && reproduced(row.evidence)

/**
 * What a problem's ending rests on.
 *  - checked: the app ran a stored reproduction and it showed the problem or showed it gone (fixed, or still happening,
 *    or left by the person after it was seen to happen); or the app's own check found the cited file or line missing.
 *  - ai: only an AI said so: a checker's statement that the code does not do it, or a fix that was made with nothing to check it against.
 *  - not_checked: nothing could be run: it could not be reproduced, or was never checked (too many reports).
 * `fixedBefore`: some row of the problem was a fix the app checked.
 */
export function howOf(row: Pick<FindingRow, 'state' | 'reason' | 'repro' | 'evidence'>, ending: Ending, fixedBefore: boolean): How {
  if (ending === 'fixed') return row.state === 'corrected' || fixedBefore ? 'checked' : 'ai'
  if (row.state === 'fixed_unchecked') return 'ai'
  if (citeRefuted(row)) return 'checked'
  if (row.state === 'refuted') return 'ai'
  return shown(row) ? 'checked' : 'not_checked'
}

function outcomeOf(row: FindingRow, ending: Ending): string {
  const s = strings.findings.ended
  if (ending === 'fixed') return s.fixedChecked
  if (ending === 'in_progress') return s.beingChecked
  if (ending === 'needs_you') return row.state === 'fixed_unchecked' ? s.fixedUnchecked : row.state === 'asked' ? s.asked : s.open
  if (citeRefuted(row)) return s.notThere
  if (row.state === 'refuted') return s.checkerNotThere
  return shown(row) ? s.youLeft : s.notReproduced
}

const safe = (text: string, max: number) => clip(redact(text), max)

/** The view of one problem, from every row that reported it. */
export function viewOf(group: FindingRow[]): FindingView {
  const latest = latestOf(group)
  const ending = endingOf(group)
  const fixedBefore = group.some(r => r.state === 'corrected' && r.evidence !== null)
  return {
    id: latest.id,
    title: strings.findings.title[latest.type],
    type: latest.type,
    state: latest.state,
    ending,
    outcome: outcomeOf(latest, ending),
    how: howOf(latest, ending, fixedBefore),
    detail: {
      where: safe(whereOf(latest), 300),
      problem: safe(latest.problem, 1000),
      command: safe(latest.repro?.command ?? '', 500),
      outputTail: safe(latest.evidence?.outputTail ?? '', 2000),
      reason: safe(latest.reason ?? '', 1000),
    },
  }
}

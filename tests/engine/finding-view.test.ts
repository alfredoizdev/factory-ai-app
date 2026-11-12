import { type Ending, type FindingRow, type FindingState } from '@/engine/findings'
import { howOf, viewOf, type How } from '@/engine/finding-view'
import { strings } from '@/ui/strings'

let n = 0
const row = (over: Partial<FindingRow> = {}): FindingRow => ({
  type: 'logic', file: 'src/a.ts', line: 3, problem: 'The button never shows.', severity: 'medium', affects: [], decisions: [],
  id: `v${n++}`, runId: 'r', projectId: 'p', round: 1, reporters: ['logic'], count: 1, state: 'reported', reason: null, repro: null, evidence: null, entryNumber: null, ...over,
})
const repro = { command: 'node check.js', marker: 'BUTTON-MISSING', files: [] }
const showed = { exitCode: 1, markerSeen: true, outputTail: 'BUTTON-MISSING', at: '2026-11-12T10:00:00.000Z' }
const passes = { exitCode: 0, markerSeen: false, outputTail: 'ok', at: '2026-11-12T10:01:00.000Z' }
const notShown = { exitCode: 0, markerSeen: false, outputTail: 'fine', at: '2026-11-12T10:00:00.000Z' }

// state x ending x what the record holds -> what the ending rests on
const TABLE: { name: string; state: FindingState; ending: Ending; over?: Partial<FindingRow>; fixedBefore?: boolean; how: How }[] = [
  { name: 'in progress, reproduced', state: 'confirmed', ending: 'in_progress', over: { repro, evidence: showed }, how: 'checked' },
  { name: 'in progress, only reported', state: 'reported', ending: 'in_progress', how: 'not_checked' },
  { name: 'in progress, could not be reproduced', state: 'unbacked', ending: 'in_progress', over: { repro, evidence: notShown }, how: 'not_checked' },
  { name: 'fixed, the check now passes', state: 'corrected', ending: 'fixed', over: { repro, evidence: passes }, how: 'checked' },
  { name: 'fixed, re-report refuted after a checked fix', state: 'refuted', ending: 'fixed', fixedBefore: true, how: 'checked' },
  { name: 'fixed, re-report set aside after a checked fix', state: 'discarded', ending: 'fixed', fixedBefore: true, how: 'checked' },
  { name: 'needs you, reproduced', state: 'asked', ending: 'needs_you', over: { repro, evidence: showed }, how: 'checked' },
  { name: 'needs you, asked but not reproduced', state: 'asked', ending: 'needs_you', how: 'not_checked' },
  { name: 'needs you, open and reproduced (fix did not hold)', state: 'open', ending: 'needs_you', over: { repro, evidence: showed }, how: 'checked' },
  { name: 'needs you, open and never checked (too many)', state: 'open', ending: 'needs_you', how: 'not_checked' },
  { name: 'needs you, fixed with no check', state: 'fixed_unchecked', ending: 'needs_you', how: 'ai' },
  { name: 'set aside, the place it points to is not there', state: 'refuted', ending: 'set_aside', over: { reason: strings.findings.noSuchFile }, how: 'checked' },
  { name: 'set aside, the line it points to is not there', state: 'refuted', ending: 'set_aside', over: { reason: strings.findings.noSuchLine }, how: 'checked' },
  { name: 'set aside, outside the copy', state: 'refuted', ending: 'set_aside', over: { reason: strings.findings.outsideCopy }, how: 'checked' },
  { name: 'set aside, the checker says the code does not do it', state: 'refuted', ending: 'set_aside', over: { reason: 'The code already handles it.' }, how: 'ai' },
  { name: 'set aside, could not be reproduced', state: 'discarded', ending: 'set_aside', over: { repro, evidence: notShown }, how: 'not_checked' },
  { name: 'set aside, no reproduction at all', state: 'discarded', ending: 'set_aside', how: 'not_checked' },
  { name: 'set aside by you, after the app showed it happens', state: 'discarded', ending: 'set_aside', over: { repro, evidence: showed }, how: 'checked' },
]

test.each(TABLE)('how: $name', ({ state, ending, over, fixedBefore, how }) => {
  expect(howOf(row({ state, ...over }), ending, fixedBefore ?? false)).toBe(how)
})

test('every state and every ending appears in the table', () => {
  const states = new Set(TABLE.map(t => t.state))
  for (const s of ['reported', 'refuted', 'unbacked', 'confirmed', 'asked', 'corrected', 'fixed_unchecked', 'discarded', 'open'] as const) expect(states.has(s)).toBe(true)
  const endings = new Set(TABLE.map(t => t.ending))
  for (const e of ['fixed', 'needs_you', 'set_aside', 'in_progress'] as const) expect(endings.has(e)).toBe(true)
})

describe('viewOf', () => {
  test('the title is a plain sentence by type, never the reviewer\'s words or a path', () => {
    const v = viewOf([row({ type: 'security', state: 'open', problem: 'SQL injection in src/db.ts' })])
    expect(v.title).toBe(strings.findings.title.security)
    expect(v.title).not.toMatch(/src\/|injection/i)
    expect(v.type).toBe('security')
  })

  test('the view is of the latest row of the problem, and its ending covers the whole group', () => {
    const first = row({ round: 1, state: 'corrected', repro, evidence: passes })
    const again = row({ round: 2, state: 'refuted' })
    const v = viewOf([first, again])
    expect(v.id).toBe(again.id)
    expect(v.ending).toBe('fixed')
    expect(v.how).toBe('checked')
  })

  test('the technical part is in detail only, and carries the reviewer\'s words, the command and the output', () => {
    const v = viewOf([row({ state: 'confirmed', repro, evidence: showed, reason: 'Seen to happen.' })])
    expect(v.detail).toEqual({ where: 'src/a.ts:3', problem: 'The button never shows.', command: 'node check.js', outputTail: 'BUTTON-MISSING', reason: 'Seen to happen.' })
    expect(JSON.stringify({ ...v, detail: null })).not.toMatch(/src\/a\.ts|node check\.js|BUTTON-MISSING/)
  })

  test('everything in detail is redacted', () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123'
    const v = viewOf([row({ state: 'confirmed', problem: `uses ${secret}`, repro: { ...repro, command: `API_KEY=${secret} node x.js` }, evidence: { ...showed, outputTail: `token: ${secret}` }, reason: `saw ${secret}` })])
    expect(JSON.stringify(v)).not.toContain(secret)
    expect(v.detail.problem).toContain('[redacted]')
  })

  test('a problem with no place or run has empty technical fields', () => {
    const v = viewOf([row({ file: undefined, line: undefined, state: 'open' })])
    expect(v.detail).toEqual({ where: '', problem: 'The button never shows.', command: '', outputTail: '', reason: '' })
  })
})

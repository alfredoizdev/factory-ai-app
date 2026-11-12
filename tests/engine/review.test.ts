import { defaultReviewerModel, FOCUSES, focusesFor, parseReview, reviewRevisionNote } from '@/engine/review'

test('the verdict is read from the JSON object the reviewer ends with, fenced or not', () => {
  const text = 'I looked at the diff.\n```json\n{"verdict":"changes","findings":[{"file":"src/a.tsx","line":12,"problem":"The shadow is missing on mobile"}]}\n```\nThat is all.'
  expect(parseReview(text)).toEqual({ verdict: 'changes', findings: [{ type: 'logic', file: 'src/a.tsx', line: 12, problem: 'The shadow is missing on mobile', severity: 'medium', affects: [], decisions: [] }] })
  expect(parseReview('All good. {"verdict":"ok","findings":[]}')).toEqual({ verdict: 'ok', findings: [] })
})

test('anything else is no verdict', () => {
  expect(parseReview('Looks fine to me!')).toBeNull()
  expect(parseReview('{"verdict":"maybe"}')).toBeNull()
  // "changes" with nothing to change would send the builder back with nothing to do.
  expect(parseReview('{"verdict":"changes","findings":[]}')).toBeNull()
  expect(parseReview('{"verdict":"changes","findings":[{"problem":"  "}]}')).toBeNull()
})

test('findings are capped and cleaned', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ problem: `p${i}`, line: -1, file: 7 }))
  const r = parseReview(JSON.stringify({ verdict: 'changes', findings: many }))!
  expect(r.findings).toHaveLength(10)
  expect(r.findings[0]).toEqual({ type: 'logic', problem: 'p0', severity: 'medium', affects: [], decisions: [] })
})

const base = { type: 'logic' as const, severity: 'medium' as const, affects: [] as string[], decisions: [] as number[] }

test('the builder is told each problem, with where it is', () => {
  const note = reviewRevisionNote([{ ...base, file: 'a.tsx', line: 3, problem: 'x' }, { ...base, problem: 'y' }])
  expect(note).toContain('1. a.tsx:3: x')
  expect(note).toContain('2. y')
})

test('the reviewer is a different model from the builder', () => {
  expect(defaultReviewerModel('opus')).toBe('sonnet')
  expect(defaultReviewerModel(undefined)).toBe('sonnet')
  expect(defaultReviewerModel('claude-sonnet-5-5')).toBe('opus')
})

test('a finding carries its type, severity, what else it affects and the decisions it touches', () => {
  const text = '{"verdict":"changes","findings":[{"type":"security","file":"a.ts","line":3,"problem":"x","severity":"high","affects":["panel"],"decisions":[7]}]}'
  expect(parseReview(text)!.findings).toEqual([{ type: 'security', file: 'a.ts', line: 3, problem: 'x', severity: 'high', affects: ['panel'], decisions: [7] }])
})

test('missing or unknown parts of a finding get their defaults', () => {
  const one = (f: object) => parseReview(JSON.stringify({ verdict: 'changes', findings: [{ problem: 'p', ...f }] }))!.findings[0]!
  expect(one({})).toMatchObject({ type: 'logic', severity: 'medium', affects: [], decisions: [] })
  expect(one({ type: 'weird', severity: 'urgent' })).toMatchObject({ type: 'logic', severity: 'medium' })
  expect(one({ type: 'effect', severity: 'low' })).toMatchObject({ type: 'effect', severity: 'low' })
  expect(one({ decisions: [3, 0, -1, 2.5, '4', 9] }).decisions).toEqual([3, 9])
  const affects = one({ affects: ['a', 'b', 'c', 'd', 'e', 'f', 7, 'x'.repeat(200)] }).affects
  expect(affects).toHaveLength(5)
  expect(one({ affects: ['x'.repeat(200)] }).affects[0]).toHaveLength(80)
})

test('a low-risk change gets one reviewer; a high-risk one gets all three', () => {
  expect(focusesFor('low')).toEqual(['logic'])
  expect(focusesFor('high')).toEqual(['logic', 'security', 'effects'])
  expect(FOCUSES).toEqual(['logic', 'security', 'effects'])
})

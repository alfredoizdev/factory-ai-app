import { defaultReviewerModel, parseReview, reviewRevisionNote } from '@/engine/review'

test('the verdict is read from the JSON object the reviewer ends with, fenced or not', () => {
  const text = 'I looked at the diff.\n```json\n{"verdict":"changes","findings":[{"file":"src/a.tsx","line":12,"problem":"The shadow is missing on mobile"}]}\n```\nThat is all.'
  expect(parseReview(text)).toEqual({ verdict: 'changes', findings: [{ file: 'src/a.tsx', line: 12, problem: 'The shadow is missing on mobile' }] })
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
  expect(r.findings[0]).toEqual({ problem: 'p0' })
})

test('the builder is told each problem, with where it is', () => {
  const note = reviewRevisionNote([{ file: 'a.tsx', line: 3, problem: 'x' }, { problem: 'y' }])
  expect(note).toContain('1. a.tsx:3: x')
  expect(note).toContain('2. y')
})

test('the reviewer is a different model from the builder', () => {
  expect(defaultReviewerModel('opus')).toBe('sonnet')
  expect(defaultReviewerModel(undefined)).toBe('sonnet')
  expect(defaultReviewerModel('claude-sonnet-5-5')).toBe('opus')
})

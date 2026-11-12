import { checkReview, defaultReviewerModel, FOCUSES, focusesFor, parseReview } from '@/engine/review'
import { strings } from '@/ui/strings'

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

test('a finding\'s decision numbers are kept once each, five at most', () => {
  const text = JSON.stringify({ verdict: 'changes', findings: [{ type: 'logic', problem: 'p', decisions: [3, 3, 1, 2, 4, 5, 6, 7, 1] }] })
  expect(parseReview(text)!.findings[0]!.decisions).toEqual([3, 1, 2, 4, 5])
})

// Real answers from the claude CLI (sonnet), on a correct change: the reviewer quoted the JSX it read, and its braces
// came before the verdict object.
const REAL_LOGIC = 'The change does what was asked. `src/app/sum.ts` now exports `sum(a, b)` returning `a + b`, so the earlier subtraction bug is fixed. `src/app/page.tsx` imports `sum` and renders `<p>2 + 2 = {sum(2, 2)}</p>` directly under the `<h1>`, which gives "2 + 2 = 4". The page change is limited to the import and that one line, so nothing extra was changed in `src/app/`. I read the diff and the files but didn\'t run the app or a build.\n\n{"verdict":"ok","findings":[]}'
const REAL_SECURITY = 'The change does what was asked, and I found no security problems.\n\n- **`src/app/sum.ts`:** `sum` now returns `a + b`, so the earlier subtraction bug is fixed.\n- **`src/app/page.tsx`:** the page imports `sum` and renders `<p>2 + 2 = {sum(2, 2)}</p>` right under the `<h1>`. That shows "2 + 2 = 4".\n- **Security:** both inputs are hardcoded constants. There is no user input, no secrets, no access checks involved and no data exposure.\n\n{"verdict":"ok","findings":[]}'

test('a real "nothing to report" answer that quotes code with braces before its verdict is read', () => {
  expect(parseReview(REAL_LOGIC)).toEqual({ verdict: 'ok', findings: [] })
  expect(parseReview(REAL_SECURITY)).toEqual({ verdict: 'ok', findings: [] })
})

test('braces in the prose, a code fence, or text after the object do not hide the verdict', () => {
  expect(parseReview('It renders {count} and calls f({ a: 1 }).\n```json\n{"verdict":"ok","findings":[]}\n```')).toEqual({ verdict: 'ok', findings: [] })
  expect(parseReview('See {x}. {"verdict":"ok","findings":[]} Thanks {y}')).toEqual({ verdict: 'ok', findings: [] })
  const changes = 'The JSX `{items.map(i => <li>{i}</li>)}` drops the key.\n{"verdict":"changes","findings":[{"file":"a.tsx","line":3,"problem":"use {key} on each <li>"}]}'
  expect(parseReview(changes)!.findings.map(f => f.problem)).toEqual(['use {key} on each <li>'])
})

test('with an ok verdict, findings may be left out or null', () => {
  expect(parseReview('{"verdict":"ok"}')).toEqual({ verdict: 'ok', findings: [] })
  expect(parseReview('Fine. {"verdict":"ok","findings":null}')).toEqual({ verdict: 'ok', findings: [] })
})

test('the last verdict counts, and an answer with no verdict at all is still no verdict', () => {
  expect(parseReview('{"verdict":"changes","findings":[{"problem":"p"}]} then, on a second look: {"verdict":"ok","findings":[]}')).toEqual({ verdict: 'ok', findings: [] })
  expect(parseReview('It renders {sum(2, 2)} and looks right.')).toBeNull()
  expect(parseReview('{"findings":[]}')).toBeNull()
  expect(parseReview('{"verdict":"ok"')).toBeNull()
})

test('why an answer is no verdict, for a developer', () => {
  expect(checkReview(REAL_LOGIC)).toEqual({ review: { verdict: 'ok', findings: [] } })
  expect(checkReview('Looks great!')).toEqual({ why: 'no_json' })
  expect(checkReview('It renders {sum(2, 2)}.')).toEqual({ why: 'no_json' })
  expect(checkReview('{"findings":[]}')).toEqual({ why: 'no_verdict' })
  expect(checkReview('{"verdict":"maybe"}')).toEqual({ why: 'no_verdict' })
  expect(checkReview('{"verdict":"changes","findings":[]}')).toEqual({ why: 'changes_without_findings' })
})

test('each answer form the reviewer prompt shows is read as the verdict it stands for', () => {
  const lines = strings.providers.claude.reviewPrompt({ request: 'r', baseCommit: 'abc' }).split('\n').filter(l => l.startsWith('{"verdict"'))
  expect(lines).toHaveLength(2)
  expect(parseReview(lines[0]!)).toEqual({ verdict: 'ok', findings: [] })
  expect(parseReview(lines[1]!)?.verdict).toBe('changes')
})

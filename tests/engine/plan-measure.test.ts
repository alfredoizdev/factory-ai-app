import { strings } from '@/ui/strings'
import { MAX_PLAN_ENTRIES, measurePlan, pathsOverlap } from '@/engine/plan-measure'
import type { Job } from '@/engine/plan'

const r = strings.plan.reasons
const none = { core: [], decisions: [] }
const job = (...paths: string[]): Job => ({ title: 't', done: [], paths })
const measure = (jobs: Job[], register: Parameters<typeof measurePlan>[1] = none, question: Parameters<typeof measurePlan>[0]['question'] = null) =>
  measurePlan({ jobs, question }, register)

test('one ordinary file is simple', () => {
  expect(measure([job('src/ui/Footer.tsx')])).toEqual({ simple: true, reasons: [r.simple(1)], entries: ['src/ui/Footer.tsx'] })
})

test('a job without paths, or with empty paths everywhere, has no paths', () => {
  expect(measure([{ title: 't', done: [] }]).reasons[0]).toBe(r.noPaths)
  expect(measure([job(), job()])).toMatchObject({ simple: false, reasons: [r.noPaths] })
  expect(measure([job('src/ui/a.tsx'), { title: 't', done: [] }])).toMatchObject({ simple: false, reasons: [r.noPaths] })
  expect(measure([]).simple).toBe(false)
})

test('one job that is not simple stops the whole plan', () => {
  const v = measure([job('src/ui/a.tsx'), job('src/lib/auth/session.ts')])
  expect(v.simple).toBe(false)
  expect(v.reasons).toContain(r.sensitive(strings.risk.areas.auth))
  expect(v.reasons).toHaveLength(1)
})

test('a sensitive area is named once, even for several files', () => {
  const v = measure([job('src/lib/auth/a.ts', 'src/lib/auth/b.ts')])
  expect(v.reasons).toEqual([r.sensitive(strings.risk.areas.auth)])
})

test('a folder is sensitive when a sensitive pattern matches the folder itself', () => {
  expect(measure([job('src/app/api/')]).reasons).toEqual([r.sensitive(strings.risk.areas.server)])
  expect(measure([job('.github/workflows/')]).reasons).toEqual([r.sensitive(strings.risk.areas.deploy)])
  expect(measure([job('src/ui/footer/')]).simple).toBe(true)
})

test('sensitive files that only a file name shows are caught', () => {
  expect(measure([job('package.json')]).reasons).toEqual([r.sensitive(strings.risk.areas.config)])
  expect(measure([job('src/app/x/route.ts')]).reasons).toEqual([r.sensitive(strings.risk.areas.server)])
})

test.each(['src/**/*.tsx', '/etc/x', '../x.ts', '.', './', 'src/../x.ts', 'a/{b,c}.ts', ''])('%j cannot be measured', entry => {
  expect(measure([job(entry)])).toMatchObject({ simple: false, reasons: [r.unmeasurable(entry)] })
})

test('a top-level folder is too wide', () => {
  expect(measure([job('src/')]).reasons).toEqual([r.tooWide('src/')])
  expect(measure([job('src/ui/')]).simple).toBe(true)
})

test('the folder rule works both ways against core areas, and by whole segments', () => {
  expect(measure([job('src/ledger/total.ts')], { core: ['src/ledger/'], decisions: [] }).reasons).toContain(r.core)
  expect(measure([job('src/ledger/')], { core: ['src/ledger/total.ts'], decisions: [] }).reasons).toEqual([r.core])
  expect(measure([job('src/ledger2/x.ts')], { core: ['src/ledger/'], decisions: [] }).simple).toBe(true)
})

test('a decision that covers a path stops the plan, once per decision; one without paths never does', () => {
  const d = { text: 'Prices round down', paths: ['src/rounding/'] }
  expect(measure([job('src/rounding/round.ts')], { core: [], decisions: [d] }).reasons).toEqual([r.decision('Prices round down')])
  expect(measure([job('src/ui/a.tsx', 'src/ui/b.tsx')], { core: [], decisions: [{ text: 'Rule', paths: ['src/ui/'] }] }).reasons).toEqual([r.decision('Rule')])
  expect(measure([job('src/ui/a.tsx')], { core: [], decisions: [{ text: 'Loose', paths: [] }] }).simple).toBe(true)
})

test('eight entries across jobs are simple; nine are not; a repeat counts once', () => {
  const f = (n: number) => `src/ui/f${n}.tsx`
  expect(measure([job(f(1), f(2)), job(f(3), f(4)), job(f(5), f(6)), job(f(7), f(8))])).toMatchObject({ simple: true, reasons: [r.simple(8)] })
  expect(MAX_PLAN_ENTRIES).toBe(8)
  expect(measure([job(f(1), f(2), f(3)), job(f(4), f(5), f(6)), job(f(7), f(8), f(9))]).reasons).toEqual([r.tooMany(9, 8)])
  const again = measure([job(f(1), f(2)), job(f(2), f(3))])
  expect(again.entries).toEqual([f(1), f(2), f(3)])
  expect(again.simple).toBe(true)
})

test('a question stops the plan and comes first', () => {
  const q = { text: 'Which?', why: 'y', paths: [], options: [] }
  expect(measure([job('src/ui/a.tsx')], none, q).reasons[0]).toBe(r.asks)
  expect(measure([job('src/ui/a.tsx')], none, 'unreadable').reasons[0]).toBe(r.questionUnreadable)
  expect(measure([], none, q).reasons.slice(0, 2)).toEqual([r.asks, r.noPaths])
})

test('reasons come in the agreed order', () => {
  const v = measure(
    [job('src/lib/auth/a.ts', 'src/**/x', 'lib/', 'src/ledger/b.ts', 'src/pricing/p.ts', 'a/1', 'a/2', 'a/3', 'a/4')],
    { core: ['src/ledger/'], decisions: [{ text: 'D', paths: ['src/pricing/'] }] },
    'unreadable',
  )
  expect(v.reasons).toEqual([
    r.questionUnreadable,
    r.unmeasurable('src/**/x'),
    r.tooWide('lib/'),
    r.sensitive(strings.risk.areas.auth),
    r.sensitive(strings.risk.areas.payments),
    r.core,
    r.decision('D'),
    r.tooMany(9, 8),
  ])
})

test('pathsOverlap', () => {
  expect(pathsOverlap('a/', 'a/b.ts')).toBe(true)
  expect(pathsOverlap('a/b.ts', 'a/')).toBe(true)
  expect(pathsOverlap('a/b.ts', 'a/b.ts')).toBe(true)
  expect(pathsOverlap('a/b.ts', 'a/c.ts')).toBe(false)
  expect(pathsOverlap('ab/', 'a/')).toBe(false)
})

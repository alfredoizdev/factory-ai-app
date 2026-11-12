import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strings } from '@/ui/strings'
import { assessRisk, classifyChange, insideCoreArea, MAX_CORE_REASONS, MAX_LOW_RISK_FILES, MAX_LOW_RISK_LINES } from '@/engine/risk'

const ok = { testsRan: true, testsPassed: true, testsChanged: false }

test('a small change to page code with passing tests is low risk', () => {
  const r = classifyChange([{ path: 'src/app/page.tsx', lines: 2 }], ok)
  expect(r.level).toBe('low')
})

test.each([
  ['src/lib/auth.ts', 'sign-in and sessions'],
  ['src/app/login/page.tsx', 'sign-in and sessions'],
  ['src/lib/stripe.ts', 'payments'],
  ['src/app/checkout/page.tsx', 'payments'],
  ['supabase/migrations/001_init.sql', 'the database'],
  ['prisma/schema.prisma', 'the database'],
  ['src/app/api/videos/route.ts', 'server routes'],
  ['src/middleware.ts', 'server routes'],
  ['package.json', 'dependencies and configuration'],
  ['pnpm-lock.yaml', 'dependencies and configuration'],
  ['next.config.ts', 'dependencies and configuration'],
  ['.env.local', 'secrets and environment'],
  ['.github/workflows/ci.yml', 'deployment'],
  ['Dockerfile', 'deployment'],
])('touching %s is high risk because it is %s', (path, area) => {
  const r = classifyChange([{ path, lines: 1 }], ok)
  expect(r.level).toBe('high')
  expect(r.reasons.join(' ')).toContain(area)
  expect(r.reasons.join(' ')).toContain(path)
})

test('a change bigger than the limits is high risk, whatever it touches', () => {
  const many = Array.from({ length: MAX_LOW_RISK_FILES + 1 }, (_, i) => ({ path: `src/components/C${i}.tsx`, lines: 1 }))
  expect(classifyChange(many, ok).level).toBe('high')
  expect(classifyChange([{ path: 'src/app/page.tsx', lines: MAX_LOW_RISK_LINES + 1 }], ok).level).toBe('high')
})

test('without passing tests, or with changed tests, nothing is low risk', () => {
  const small = [{ path: 'src/app/page.tsx', lines: 2 }]
  expect(classifyChange(small, { ...ok, testsRan: false }).level).toBe('high')
  expect(classifyChange(small, { ...ok, testsPassed: false }).level).toBe('high')
  expect(classifyChange(small, { ...ok, testsChanged: true }).level).toBe('high')
})

test('a run that changed nothing is not waved through as "low risk"', () => {
  expect(classifyChange([], ok).level).toBe('high')
})

test('the assessment reads the real diff of the worktree: committed, edited and new files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-risk-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  const write = (p: string, body: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  git('init', '-q')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  write('src/app/page.tsx', 'a\nb\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  write('src/app/page.tsx', 'a\nB\n')
  expect(assessRisk(dir, base, ok)).toMatchObject({ level: 'low', files: ['src/app/page.tsx'], linesChanged: 2 })
  write('src/lib/stripe.ts', 'pay()\n') // new, untracked
  expect(assessRisk(dir, base, ok).level).toBe('high')
})

test('when the diff cannot be read, the change is treated as high risk', () => {
  expect(assessRisk(mkdtempSync(join(tmpdir(), 'nogit-')), 'abc', ok).level).toBe('high')
})

describe('core areas the person marked', () => {
  test('a change inside a core area is high risk, naming the file and the area', () => {
    const r = classifyChange([{ path: 'src/app/page.tsx', lines: 2 }], ok, ['src/app/'])
    expect(r.level).toBe('high')
    expect(r.reasons).toEqual(['src/app/page.tsx is inside src/app/, which you marked as a core area.'])
  })

  test('a core area that is one file is named as that file', () => {
    const r = classifyChange([{ path: 'src/lib/money.ts', lines: 1 }], ok, ['src/lib/money.ts'])
    expect(r.level).toBe('high')
    expect(r.reasons).toEqual(['src/lib/money.ts is a file you marked as a core area.'])
  })

  test('many files in one core area give one reason, not one per file', () => {
    const files = ['a', 'b', 'c'].map(n => ({ path: `src/app/${n}.tsx`, lines: 1 }))
    const r = classifyChange(files, ok, ['src/app/'])
    expect(r.reasons).toEqual(['src/app/a.tsx and 2 other files are inside src/app/, which you marked as a core area.'])
  })

  test('one reason per core area hit, at most MAX_CORE_REASONS, then how many more', () => {
    const areas = Array.from({ length: MAX_CORE_REASONS + 2 }, (_, i) => `src/a${i}/`)
    const r = classifyChange(areas.map(a => ({ path: `${a}x.ts`, lines: 1 })), ok, areas)
    const core = r.reasons.filter(x => x.includes('core area'))
    expect(core).toHaveLength(MAX_CORE_REASONS + 1)
    expect(core.at(-1)).toBe('It also changes 2 more core areas you marked.')
  })

  test('files outside every core area are measured as before', () => {
    expect(classifyChange([{ path: 'src/components/Button.tsx', lines: 2 }], ok, ['src/app/']).level).toBe('low')
  })

  test('the assessment of the worktree takes the core areas too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-risk-core-'))
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
    mkdirSync(join(dir, 'src/app'), { recursive: true })
    writeFileSync(join(dir, 'src/app/page.tsx'), 'a\n')
    git('init', '-q')
    git('config', 'user.email', 't@e.com')
    git('config', 'user.name', 't')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'src/app/page.tsx'), 'A\n')
    expect(assessRisk(dir, base, ok).level).toBe('low')
    expect(assessRisk(dir, base, ok, ['src/app/']).level).toBe('high')
  })
})

describe('what is still open after the review', () => {
  const base = { testsRan: true, testsPassed: true, testsChanged: false }
  test('a problem still open and a fix the app could not check are said apart, each as a full sentence', () => {
    const open = classifyChange([{ path: 'a.ts', lines: 1 }], { ...base, reviewOpen: true })
    expect(open.reasons).toEqual([strings.risk.reviewStillOpen])
    const unchecked = classifyChange([{ path: 'a.ts', lines: 1 }], { ...base, reviewUnchecked: true })
    expect(unchecked.reasons).toEqual([strings.risk.fixUnchecked])
    for (const r of [strings.risk.reviewStillOpen, strings.risk.fixUnchecked, strings.risk.reviewUnreadable]) expect(r).toMatch(/^[A-Z].*\.$/)
  })
})

describe('decisions that name files', () => {
  const change = [{ path: 'src/rounding/round.ts', lines: 3 }]
  const decision = { text: 'Prices round down', paths: ['src/rounding/'] }

  test('a change on a file a decision names is high risk, and says which decision', () => {
    expect(classifyChange(change, ok).level).toBe('low')
    const r = classifyChange(change, ok, [], [decision])
    expect(r.level).toBe('high')
    expect(r.reasons).toContain(strings.risk.onDecision('src/rounding/round.ts', 'Prices round down'))
  })

  test('a decision that names no files changes nothing', () => {
    expect(classifyChange(change, ok, [], [{ text: 'x', paths: [] }]).level).toBe('low')
  })

  test('a decision names a file exactly, and a folder with everything inside', () => {
    expect(classifyChange(change, ok, [], [{ text: 'a', paths: ['src/rounding/round.ts'] }]).level).toBe('high')
    expect(classifyChange(change, ok, [], [{ text: 'a', paths: ['src/rounding/other.ts', 'src/round'] }]).level).toBe('low')
  })

  test('six decisions hit give five reasons and one line for the rest, after the core reasons', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ text: `d${i}`, paths: ['src/rounding/'] }))
    const r = classifyChange(change, ok, ['src/rounding/'], six)
    expect(r.reasons).toEqual([
      strings.risk.insideCore('src/rounding/round.ts', 'src/rounding/', 0),
      ...[0, 1, 2, 3, 4].map(i => strings.risk.onDecision('src/rounding/round.ts', `d${i}`)),
      strings.risk.moreDecisions(1),
    ])
  })

  test('assessRisk passes the decisions on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-dec-'))
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.email', 't@e.com')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    mkdirSync(join(dir, 'src/rounding'), { recursive: true })
    writeFileSync(join(dir, 'src/rounding/round.ts'), 'x\n')
    expect(assessRisk(dir, base, ok).level).toBe('low')
    expect(assessRisk(dir, base, ok, [], [decision]).level).toBe('high')
  })
})

describe('the changed files, read from a real repository', () => {
  /** A repository with `base` committed; returns it and a way to run git in it. */
  function repo(base: Record<string, string | Buffer>) {
    const dir = mkdtempSync(join(tmpdir(), 'factory-files-'))
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.email', 't@e.com')
    git('config', 'user.name', 't')
    const write = (p: string, body: string | Buffer) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), body)
    }
    for (const [p, body] of Object.entries(base)) write(p, body)
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    return { dir, git, write, base: git('rev-parse', 'HEAD') }
  }
  const decision = { text: 'Prices round down', paths: ['src/rounding/'] }
  const body = 'line one\nline two\nline three\n'

  test('a file moved out of a decision\'s folder is judged by the path it left', () => {
    const r = repo({ 'src/rounding/round.ts': body })
    r.git('mv', 'src/rounding/round.ts', 'src/other.ts')
    const a = assessRisk(r.dir, r.base, ok, [], [decision])
    expect(a.level).toBe('high')
    expect(a.reasons).toContain(strings.risk.onDecision('src/rounding/round.ts', 'Prices round down'))
    expect(a.files.sort()).toEqual(['src/other.ts', 'src/rounding/round.ts'])
  })

  test('a file moved into a decision\'s folder is judged by the path it arrived at', () => {
    const r = repo({ 'src/other.ts': body })
    mkdirSync(join(r.dir, 'src/rounding'), { recursive: true })
    r.git('mv', 'src/other.ts', 'src/rounding/round.ts')
    const a = assessRisk(r.dir, r.base, ok, [], [decision])
    expect(a.level).toBe('high')
    expect(a.reasons).toContain(strings.risk.onDecision('src/rounding/round.ts', 'Prices round down'))
  })

  test('a file with a non-ASCII name is read as it is named, in a core area and by a sensitive pattern', () => {
    const r = repo({ 'src/ledger/é.ts': 'a\n', 'src/plain.ts': 'a\n' })
    r.write('src/ledger/é.ts', 'b\n')
    r.write('src/ledger/ñ-new.ts', 'c\n')
    const a = assessRisk(r.dir, r.base, ok, ['src/ledger/'], [])
    expect(a.files.sort()).toEqual(['src/ledger/é.ts', 'src/ledger/ñ-new.ts'].sort())
    expect(a.level).toBe('high')
    expect(a.reasons).toEqual([strings.risk.insideCore('src/ledger/é.ts', 'src/ledger/', 1)])
    const s = repo({ 'x.txt': 'x\n' })
    s.write('pagos/stripe-é.ts', 'c\n')
    expect(assessRisk(s.dir, s.base, ok).reasons).toContain(strings.risk.touches('pagos/stripe-é.ts', strings.risk.areas.payments))
  })

  test('a deleted file inside a decision\'s folder is judged', () => {
    const r = repo({ 'src/rounding/round.ts': body })
    execFileSync('rm', [join(r.dir, 'src/rounding/round.ts')])
    const a = assessRisk(r.dir, r.base, ok, [], [decision])
    expect(a.level).toBe('high')
    expect(a.reasons).toContain(strings.risk.onDecision('src/rounding/round.ts', 'Prices round down'))
  })

  test('a binary file is judged by its path and counted as before', () => {
    const r = repo({ 'src/rounding/logo.png': Buffer.from([0, 1, 2, 3]) })
    r.write('src/rounding/logo.png', Buffer.from([0, 9, 8, 7, 0]))
    const a = assessRisk(r.dir, r.base, ok, [], [decision])
    expect(a.level).toBe('high')
    expect(a.reasons).toContain(strings.risk.onDecision('src/rounding/logo.png', 'Prices round down'))
    expect(a.linesChanged).toBe(2)
  })
})

describe('core areas and decisions are compared without regard to case', () => {
  test.each([
    ['src/Ledger/', 'src/ledger/x.ts'],
    ['src/ledger/', 'src/Ledger/x.ts'],
    ['src/Ledger/x.ts', 'src/ledger/X.ts'],
  ])('%s catches %s', (pattern, path) => {
    expect(insideCoreArea(path, pattern)).toBe(true)
    expect(classifyChange([{ path, lines: 1 }], ok, [pattern]).level).toBe('high')
    expect(classifyChange([{ path, lines: 1 }], ok, [], [{ text: 'd', paths: [pattern] }]).level).toBe('high')
  })
  test('a different name is still not caught', () => {
    expect(insideCoreArea('src/ledgers/x.ts', 'src/Ledger/')).toBe(false)
  })
})

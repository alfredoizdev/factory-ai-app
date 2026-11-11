import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assessRisk, classifyChange, MAX_LOW_RISK_FILES, MAX_LOW_RISK_LINES } from '@/engine/risk'

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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

// The browser bundle must not reach the database client, `pg` or a Node built-in. Vitest does not bundle, so nothing else
// notices: this walks the VALUE imports (type-only imports are erased) from every file under src/ui and prints the chain.

const SRC = resolve(process.cwd(), 'src')
const FORBIDDEN_FILES = new Set([join(SRC, 'db/client.ts')])
const FORBIDDEN_PACKAGES = new Set(['pg', ...builtinModules])

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/** The module specifiers a file imports by value. `import type` and `{ type A }`-only imports are left out. */
export function valueImports(source: string): string[] {
  const out: string[] = []
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const m of code.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[2]) continue
    const clause = m[3] ?? ''
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim())
    if (named && named[1]!.split(',').map(s => s.trim()).filter(Boolean).every(s => s.startsWith('type '))) continue
    out.push(m[4]!)
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!)
  return out
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null
  if (!base) return null
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

function chainsToForbidden(): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return
    seen.add(file)
    const here = [...chain, relative(process.cwd(), file)]
    if (FORBIDDEN_FILES.has(file)) return void found.push(here.join(' -> '))
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      const pkg = spec.replace(/^node:/, '').split('/')[0]!
      if (spec.startsWith('node:') || FORBIDDEN_PACKAGES.has(pkg)) {
        if (!spec.startsWith('.') && !spec.startsWith('@/')) found.push(`${here.join(' -> ')} -> ${spec}`)
        continue
      }
      const next = resolveLocal(file, spec)
      if (next) walk(next, here)
    }
  }
  for (const file of filesUnder(join(SRC, 'ui'))) walk(file, [])
  return found
}

test('no screen file reaches the database client, pg or a Node built-in by a value import', () => {
  expect(chainsToForbidden()).toEqual([])
})

test('the walker tells value imports from type imports', () => {
  const src = [
    "import type { A } from '@/db/client'",
    "import { type B, type C } from '@/db/client'",
    "import { x, type D } from '@/one'",
    "import E from '@/two'",
    "export { y } from './three'",
    "import './four.css'",
    "// import { z } from '@/commented'",
  ].join('\n')
  expect(valueImports(src)).toEqual(['@/one', '@/two', './three', './four.css'])
})

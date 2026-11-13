import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { defaultBranch } from '@/engine/branches'
import { validRepoRoot } from '@/engine/project-settings'

// Reading a repository once, when it becomes a project: how it installs, what it can check, where it lives on GitHub
// and what deploys it. Everything here is read from files and from git/gh; nothing is installed or changed.

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'
export type CheckName = 'test' | 'lint' | 'build' | 'typecheck'
export type GhState = 'ready' | 'not-installed' | 'not-logged-in' | 'not-github' | 'no-remote'

export type ProjectAnalysis = {
  root: string
  /** The package's own name, or the folder's. */
  name: string
  packageManager: PackageManager | null
  framework: string | null
  /** Each check the project defines, as the command that runs it the way the project installs; null when it has none. */
  commands: Record<CheckName, string | null>
  defaultBranch: string | null
  /** The branch the folder is on right now; null when it is on none. */
  currentBranch?: string | null
  github: { repo: string | null; gh: GhState }
  /** What deploys it or runs on it, as far as the repository says: hosts and CI workflows. */
  deploy: string[]
  /** The project's own folders (top level and inside src/), for the person to mark as "ask me before changing". */
  folders: string[]
}

const FRAMEWORKS: readonly [string, string][] = [
  ['next', 'Next.js'],
  ['@remix-run/react', 'Remix'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['nuxt', 'Nuxt'],
  ['astro', 'Astro'],
  ['@angular/core', 'Angular'],
  ['vite', 'Vite'],
  ['express', 'Express'],
  ['react', 'React'],
  ['vue', 'Vue'],
]

/** Scripts that only print "no test specified" are not checks. */
const PLACEHOLDER = /no test specified/

export function packageManagerOf(dir: string): PackageManager | null {
  const has = (f: string) => existsSync(join(dir, f))
  if (!has('package.json')) return null
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('yarn.lock')) return 'yarn'
  if (has('bun.lockb') || has('bun.lock')) return 'bun'
  return 'npm'
}

/** How a package script is run with this package manager. */
export function runScript(pm: PackageManager, script: string): string {
  if (pm === 'npm') return script === 'test' ? 'npm test' : `npm run ${script}`
  if (pm === 'bun') return `bun run ${script}`
  return `${pm} ${script}`
}

type Pkg = { name?: unknown; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }

function readPkg(dir: string): Pkg | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg
  } catch {
    return null
  }
}

/** The project's checks, from its scripts. typecheck also answers to "type-check" and "tsc". */
export function commandsOf(dir: string): Record<CheckName, string | null> {
  const none = { test: null, lint: null, build: null, typecheck: null }
  const pm = packageManagerOf(dir)
  const pkg = readPkg(dir)
  if (!pm || !pkg) return none
  const scripts = pkg.scripts ?? {}
  const usable = (name: string) => typeof scripts[name] === 'string' && (scripts[name] as string).trim() !== '' && !PLACEHOLDER.test(scripts[name] as string)
  const pick = (...names: string[]) => {
    const found = names.find(usable)
    return found ? runScript(pm, found) : null
  }
  return { test: pick('test'), lint: pick('lint'), build: pick('build'), typecheck: pick('typecheck', 'type-check', 'tsc') }
}

/**
 * The test command the project's main branch has, here or on origin (as last fetched): what a new task would start
 * with. Used to notice tests that arrived after the project was added. Null when there is none.
 */
export function testCommandOnMain(repo: string): string | null {
  const pm = packageManagerOf(repo)
  const branch = defaultBranch(repo)
  if (!pm || !branch) return null
  for (const ref of [branch, `origin/${branch}`]) {
    try {
      const pkg = JSON.parse(execFileSync('git', ['show', `${ref}:package.json`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as Pkg
      const script = pkg.scripts?.test
      if (typeof script === 'string' && script.trim() !== '' && !PLACEHOLDER.test(script)) return runScript(pm, 'test')
    } catch {
      // No such ref, or no package.json on it: try the next.
    }
  }
  return null
}

export function frameworkOf(dir: string): string | null {
  const pkg = readPkg(dir)
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  return FRAMEWORKS.find(([dep]) => dep in deps)?.[1] ?? null
}

export function deployOf(dir: string): string[] {
  const out: string[] = []
  if (existsSync(join(dir, 'vercel.json')) || existsSync(join(dir, 'vercel.ts')) || existsSync(join(dir, '.vercel', 'project.json'))) out.push('Vercel')
  if (existsSync(join(dir, 'netlify.toml'))) out.push('Netlify')
  if (existsSync(join(dir, 'fly.toml'))) out.push('Fly.io')
  if (existsSync(join(dir, 'render.yaml'))) out.push('Render')
  if (existsSync(join(dir, 'Dockerfile'))) out.push('Docker')
  const workflows = join(dir, '.github', 'workflows')
  if (existsSync(workflows)) {
    for (const f of readdirSync(workflows).filter(f => /\.ya?ml$/.test(f)).sort()) out.push(`GitHub Actions: ${f}`)
  }
  return out
}

/** owner/name of a github.com remote, never the URL itself (which can carry a token). */
export function githubRepoOf(remote: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

export type GhProbe = () => Promise<'ready' | 'not-installed' | 'not-logged-in'>

const probeGh: GhProbe = () =>
  new Promise(resolve =>
    execFile('gh', ['auth', 'status'], { timeout: 10_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, err => {
      if (!err) return resolve('ready')
      resolve((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'not-logged-in')
    }),
  )

/** Reads a repository. Refused (by validRepoRoot's own message) when the path is not a repository's top folder. */
function currentBranchOf(root: string): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

export async function analyzeProject(path: string, gh: GhProbe = probeGh): Promise<ProjectAnalysis> {
  const root = validRepoRoot(path)
  const pkg = readPkg(root)
  let remote: string | null = null
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    remote = null
  }
  const repo = remote ? githubRepoOf(remote) : null
  const ghState: GhState = remote === null ? 'no-remote' : repo === null ? 'not-github' : await gh()
  return {
    root,
    name: typeof pkg?.name === 'string' && pkg.name.trim() !== '' ? pkg.name.trim() : basename(root),
    packageManager: packageManagerOf(root),
    framework: frameworkOf(root),
    commands: commandsOf(root),
    defaultBranch: defaultBranch(root),
    currentBranch: currentBranchOf(root),
    github: { repo, gh: ghState },
    deploy: deployOf(root),
    folders: foldersOf(root),
  }
}

const NOT_SOURCE = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'public', 'vendor', 'tmp'])
export const MAX_FOLDERS = 16

/** The folders a person would recognise as parts of the project: top level and one level inside src/, each ending in "/". */
export function foldersOf(dir: string): string[] {
  const dirsIn = (rel: string) => {
    try {
      return readdirSync(join(dir, rel), { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && !NOT_SOURCE.has(e.name))
        .map(e => `${rel}${e.name}/`)
        .sort()
    } catch {
      return []
    }
  }
  const top = dirsIn('')
  // src/ itself says little; what is inside it does.
  const out = top.flatMap(f => (f === 'src/' ? dirsIn('src/') : [f]))
  return out.slice(0, MAX_FOLDERS)
}

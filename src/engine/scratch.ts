import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ProjectSettingsError } from '@/engine/project-settings'
import { githubRepoOf } from '@/engine/project-setup'
import { strings } from '@/ui/strings'

// Starting a project from nothing. The app can only take a folder that is a git repository with a commit, so this
// makes exactly that and no more: the folder, a repository on "main", a README and a first commit. What the project
// is made of is built afterwards by the agents, as its first task. Nothing is sent anywhere.

const s = strings.wizard.errors

/** Files a "new" folder may already hold without counting as someone's work. */
const IGNORABLE = new Set(['.DS_Store'])

/** The address as git will keep it, or null when none was given. Only github.com addresses are taken. */
export function cleanGitHubUrl(raw: string | null | undefined): string | null {
  const url = (raw ?? '').trim()
  if (url === '') return null
  // An address with a name and password in it would be stored in the repository's settings: refused.
  if (/^https?:\/\/[^/]*@/i.test(url) || githubRepoOf(url) === null) throw new ProjectSettingsError(s.notGitHub)
  return url
}

/** Throws the plain sentence for a folder a new project cannot start in. */
export function checkNewFolder(path: string): void {
  if (!isAbsolute(path)) throw new ProjectSettingsError(strings.settings.notAbsolute)
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) throw new ProjectSettingsError(s.notFolder)
    if (readdirSync(path).some(f => !IGNORABLE.has(f))) throw new ProjectSettingsError(s.notEmpty)
    return
  }
  const parent = dirname(path)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new ProjectSettingsError(s.noParent)
}

/**
 * Makes the folder a repository with one commit, and remembers the GitHub address as origin when one was given.
 * Returns the folder. Everything is checked before anything is created.
 */
export function startFromScratch(input: { path: string; name: string; githubUrl?: string | null }): string {
  const path = input.path.trim().replace(/\/+$/, '')
  const origin = cleanGitHubUrl(input.githubUrl)
  checkNewFolder(path)
  mkdirSync(path, { recursive: true })
  const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(path, 'README.md'), `# ${input.name.trim()}\n\n${strings.wizard.readmeLine}\n`)
  git(['add', 'README.md'])
  git(['-c', 'user.name=AI Factory', '-c', 'user.email=ai-factory@localhost', 'commit', '-q', '--no-verify', '-m', strings.wizard.firstCommit])
  if (origin) git(['remote', 'add', 'origin', origin])
  return path
}

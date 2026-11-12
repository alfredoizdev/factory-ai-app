import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { runs } from '@/db/schema'
import { defaultBranch } from '@/engine/branches'
import { projectHere } from '@/engine/machine'
import { clip, redact } from '@/engine/redact'
import { strings } from '@/ui/strings'

// Connecting a project that only lives on this computer to GitHub, from the app: either a new private repository made
// with the person's own `gh` login, or one they already have, given by its link. Both end with the main branch
// uploaded, so sending a change to be checked works straight after. Nothing happens unless the person presses for it.

export class ConnectError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 409) {
    super(message)
    this.name = 'ConnectError'
  }
}

export type Exec = (file: 'git' | 'gh', args: string[], cwd: string) => Promise<string>

const defaultExec: Exec = (file, args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error(String(stderr || err.message)), { code: (err as NodeJS.ErrnoException).code })) : resolve(String(stdout)),
    ),
  )

/** A link to a GitHub repository, as the site or `git` gives it. Nothing else is accepted as a remote. */
const GITHUB_URL = /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?|git@github\.com:[\w.-]+\/[\w.-]+?(\.git)?)$/

export function githubUrl(raw: string): string | null {
  const url = raw.trim()
  return GITHUB_URL.test(url) ? url.replace(/\/$/, '') : null
}

const c = strings.delivery.connect
const detail = (e: unknown) => clip(redact(e instanceof Error ? e.message : String(e)).trim(), 300)

/** A failure from `gh` or `git`, said in words a person can act on, with what the tool printed after it. */
function explain(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return c.noGh
  if (/gh auth login|not logged in|authentication/i.test(text)) return c.notLoggedIn
  if (/name already exists/i.test(text)) return c.nameTaken
  if (/repository not found|could not read from remote|does not appear to be a git repository/i.test(text)) return c.notFound
  if (/rejected|fetch first|non-fast-forward/i.test(text)) return c.notEmpty
  return c.failed(detail(e))
}

/**
 * Connects the project of this run to GitHub and uploads its main branch. `how.create` makes a new private repository
 * named after the project's folder; `how.url` uses one the person already has. Already connected: nothing to do.
 */
export async function connectGithub(runId: string, how: { create: true } | { url: string }, exec: Exec = defaultExec): Promise<{ url: string | null }> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run) throw new ConnectError(strings.errors.runNotFound, 404)
  const repo = (await projectHere(run.projectId))?.repoPath
  if (!repo) throw new ConnectError(c.noFolder)
  const origin = () => exec('git', ['remote', 'get-url', 'origin'], repo).then(s => s.trim() || null, () => null)
  const already = await origin()
  if (already) return { url: already }
  const main = defaultBranch(repo) ?? 'main'

  if ('url' in how) {
    const url = githubUrl(how.url)
    if (!url) throw new ConnectError(c.badLink, 400)
    await exec('git', ['remote', 'add', 'origin', url], repo)
    try {
      await exec('git', ['push', '-u', 'origin', main], repo)
    } catch (e) {
      // Left as it was found: a remote that could not be uploaded to would only make the next step fail instead.
      await exec('git', ['remote', 'remove', 'origin'], repo).catch(() => undefined)
      throw new ConnectError(explain(e))
    }
    return { url }
  }

  try {
    await exec('gh', ['repo', 'create', basename(repo), '--private', '--source', '.', '--remote', 'origin'], repo)
    await exec('git', ['push', '-u', 'origin', main], repo)
  } catch (e) {
    throw new ConnectError(explain(e))
  }
  return { url: await origin() }
}

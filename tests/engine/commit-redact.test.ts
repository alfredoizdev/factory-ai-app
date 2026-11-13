import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fallbackWords } from '@/engine/branch-name'
import { keepCommit } from '@/engine/delivery'

// What the app sends to GitHub on its own (the commit, which becomes the pull request, and the branch name) never
// carries a secret, whether the person wrote it in the request or the model repeated it in its description.
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

it('takes a secret out of the description the model wrote for the commit', () => {
  dir = mkdtempSync(join(tmpdir(), 'factory-redact-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  const sha = keepCommit(
    { id: 'run-1', request: `Use ${TOKEN} to call the API`, worktreePath: dir },
    { subject: `Call the API with ${TOKEN}`, body: `The header now carries ${TOKEN}.` },
    'app',
  )
  const message = git('log', '-1', '--format=%B', sha)
  expect(message).not.toContain(TOKEN)
  expect(message).toContain('Call the API with [redacted]')
  expect(message).toContain('The header now carries [redacted].')
})

it('never puts a secret from the request in the fallback branch name', () => {
  const words = fallbackWords(`Use ${TOKEN} to call the weather API`)
  expect(words).not.toContain('ghp')
  expect(words).not.toContain('abcdefghijklmnopqrstuvwxyz')
  expect(words).toContain('weather')
})

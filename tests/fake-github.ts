import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// An origin that is GitHub in every way the app can read it (its fetch and push addresses are github.com), while git
// itself talks only to a bare repository in a temporary folder. Git hands a remote with `vcs = factorytest` to a helper
// program named git-remote-factorytest; this one connects git to the bare repository named in the remote's
// `testpushto`, and never to a host. Every network protocol is switched off for the repository as well, so without the
// helper nothing can be sent anywhere.

const HELPER = `#!/bin/sh
to=$(git config --get "remote.$1.testpushto")
while read -r line; do
  case "$line" in
    capabilities) printf 'connect\\n\\n' ;;
    "connect "*) printf '\\n'; exec git "\${line#connect git-}" "$to" ;;
    "") exit 0 ;;
  esac
done
`

let ready = false

/** Puts the helper where git finds it (once per test file). */
function installHelper(): void {
  if (ready) return
  const dir = mkdtempSync(join(tmpdir(), 'factory-fake-github-'))
  const file = join(dir, 'git-remote-factorytest')
  writeFileSync(file, HELPER)
  chmodSync(file, 0o755)
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`
  ready = true
}

/** Makes `origin` of `dir` the GitHub repository `github` (owner/name), with everything sent landing in `bare`. */
export function fakeGitHubOrigin(dir: string, bare: string, github = 'ai-factory-test/never-real'): void {
  installHelper()
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('remote', 'add', 'origin', `https://github.com/${github}.git`)
  git('config', 'remote.origin.vcs', 'factorytest')
  git('config', 'remote.origin.testpushto', bare)
  for (const p of ['https', 'http', 'ssh', 'git']) git('config', `protocol.${p}.allow`, 'never')
}

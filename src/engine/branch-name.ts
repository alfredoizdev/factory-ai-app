import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { redact } from '@/engine/redact'

// Naming the branch an approved change is kept on. The first words of a request make a poor name ("primero ejecuta
// pnpm install en la..."), so a small, fast model is asked for a few words that say what changed. Whatever it says is
// only used when it is plainly a branch-safe slug; anything else, a timeout, or no `claude` at all falls back to the
// request's own meaningful words. Either way the run's last six characters keep the name unique.

/** Two to six lowercase words joined by hyphens: nothing a branch name or a shell could read as anything else. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/
const MAX_SLUG = 48

export function branchFromWords(runId: string, words: string): string {
  return `ai/${words}-${runId.slice(-6).toLowerCase()}`
}

/** The model's answer, accepted only when it is a clean slug. Quotes, backticks and a trailing full stop are forgiven. */
export function cleanWords(raw: string): string | null {
  const first = raw.trim().split('\n')[0]?.trim().toLowerCase().replace(/^[`'"]+|[`'".]+$/g, '').replace(/^ai\//, '') ?? ''
  return SLUG.test(first) && first.length <= MAX_SLUG ? first : null
}

// Words that say nothing about the change: filler, articles, and the commands people put in front of the real ask.
const FILLER = new Set(
  (
    'a al an and are as at be by con de del el en es esta este first for from haz in is it la las lo los make me mi ' +
    'my no now of on or para please por primero que se sin so solo the then to un una uno y ya you your ' +
    'ejecuta ejecutar run install pnpm npm yarn bun cambia cambiar change quiero want can could would nada mas more'
  ).split(' '),
)

/** The request's own meaningful words, without paths, file names or filler: the fallback name. */
export function fallbackWords(request: string): string | null {
  // The name is sent to GitHub with the branch: a secret written in the request never becomes part of it.
  const words = redact(request)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => !/[/\\]|\.[a-z]{1,4}\b/.test(w)) // src/app/page.tsx, ./foo, page.tsx
    .map(w => w.replace(/[^a-z0-9]+/g, ''))
    .filter(w => w.length > 1 && !FILLER.has(w) && !/^\d+(px|rem|em|%)?$/.test(w))
  const picked: string[] = []
  for (const w of words) {
    if (picked.includes(w)) continue
    if ([...picked, w].join('-').length > MAX_SLUG) break
    picked.push(w)
    if (picked.length === 5) break
  }
  return picked.length > 0 ? picked.join('-') : null
}

export type AskModel = (prompt: string) => Promise<string>

/** One short, tool-less call to a fast model, without the person's own settings, hooks or MCP servers. */
export const askClaude: AskModel = prompt =>
  new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', '--model', 'haiku', '--setting-sources', '', '--strict-mcp-config', prompt],
      { cwd: tmpdir(), timeout: 20_000, maxBuffer: 64 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })

/** A few words naming what this change does, for its branch. Never throws: the fallback always answers. */
export async function suggestBranchWords(request: string, files: readonly string[], ask: AskModel = askClaude): Promise<string> {
  const prompt =
    'Name a git branch for this change. Reply with ONLY 2 to 5 lowercase English words joined by hyphens that say ' +
    `what changed, nothing else.\nRequest: ${request.slice(0, 2000)}\nFiles changed: ${files.slice(0, 20).join(', ') || 'unknown'}`
  try {
    const words = cleanWords(await ask(prompt))
    if (words) return words
  } catch {
    // No claude, a timeout, or an error: the request's own words will do.
  }
  return fallbackWords(request) ?? 'change'
}

export type CommitMessage = { subject: string; body: string }

/**
 * A commit message that says what the diff did, written by the same fast model. Accepted only when the first line is a
 * plain summary of at most 72 characters; anything else, or no answer, is null and the caller falls back.
 */
export async function suggestCommitMessage(request: string, diff: string, ask: AskModel = askClaude): Promise<CommitMessage | null> {
  if (diff.trim() === '') return null
  const prompt =
    'Write a git commit message for this diff. Line 1: an imperative summary of what the code change does, at most 72 ' +
    'characters. Then a blank line, then 1 to 4 short lines starting with "- " saying what changed. English. Reply ' +
    `with the message only.\nWhat the person asked for (context only): ${request.slice(0, 1000)}\nDiff:\n${diff.slice(0, 12_000)}`
  let raw: string
  try {
    raw = await ask(prompt)
  } catch {
    return null
  }
  const lines = raw.replace(/```[a-z]*\n?/g, '').trim().split('\n')
  const subject = (lines[0] ?? '').trim().replace(/^["'`]+|["'`]+$/g, '')
  if (subject.length < 3 || subject.length > 72 || /[:!]$/.test(subject) || /^(sure|here|okay|ok)\b/i.test(subject)) return null
  const body = lines
    .slice(1)
    // Trailers the model adds out of habit; the commit carries its own provenance line.
    .filter(l => !/^\s*(co-authored-by|signed-off-by|generated with)\b/i.test(l) && !l.includes('🤖'))
    .join('\n')
    .trim()
    .slice(0, 800)
  return { subject, body }
}

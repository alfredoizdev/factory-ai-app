// Everything a real agent prints can reach the event log, and the event log reaches the browser. This is the one
// place that text is cleaned before it is stored. It errs towards removing too much: a step that reads "[redacted]"
// costs nothing, a token on screen costs the account.

const R = '[redacted]'

// Order matters: whole blocks first, then tokens with a recognisable shape, then name=value assignments.
const PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  // NAME=value, NAME: value, "name": "value" — where the name says it is a secret. The name stays, the value goes.
  [
    /(["']?[A-Za-z0-9_]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',}]+)/gi,
    `$1${R}`,
  ],
]

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i
const MIN_SECRET_LENGTH = 8

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text
  // The values of this machine's own secret variables, wherever they turn up (a `cat .env`, an echoed command).
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH || !SECRET_NAME.test(name)) continue
    out = out.replace(new RegExp(escape(value), 'g'), R)
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Cuts text to at most `max` characters, ending in an ellipsis when it had to cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

import { relative, isAbsolute } from 'node:path'
import { clip, redact } from '@/engine/redact'
import type { AgentEvent } from '@/providers/types'

// Turns one line of `claude -p --output-format stream-json` into what the canvas may show. Pure. Only tool calls
// become steps: they are actions the agent took, which is what "what is it doing" means. Its prose is not a step,
// hook output never passes, and the final sentence is a claim — the executor stores it as one.

const STEP_MAX = 120
const SUMMARY_MAX = 600

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function shownPath(path: string, workdir: string): string {
  if (!path) return 'a file'
  const rel = relative(workdir, path)
  // A path outside the worktree is shown whole, so an edit where it should not be is visible, not tidied away.
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

export function toolStep(name: string, input: Obj, workdir: string): string {
  const path = shownPath(str(input.file_path) || str(input.notebook_path), workdir)
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${path}`
    case 'Write':
      return `Writing ${path}`
    case 'Read':
      return `Reading ${path}`
    case 'Bash':
      return clip(`Running: ${redact(str(input.command).replace(/\s+/g, ' ').trim())}`, STEP_MAX)
    case 'Grep':
    case 'Glob':
      return 'Searching the code'
    case 'TodoWrite':
      return 'Updating its task list'
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking something up on the web'
    case 'Task':
      return 'Handing part of the work to a helper agent'
    default:
      return clip(`Using ${name}`, STEP_MAX)
  }
}

function reportedTokens(usage: unknown): number | null {
  if (!isObj(usage)) return null
  const parts = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map(k => usage[k])
  if (!parts.some(p => typeof p === 'number')) return null
  return parts.reduce<number>((sum, p) => sum + (typeof p === 'number' ? p : 0), 0)
}

export function mapStreamLine(line: unknown, workdir: string): AgentEvent[] {
  if (!isObj(line)) return []
  if (line.type === 'assistant') {
    const content = isObj(line.message) ? line.message.content : undefined
    if (!Array.isArray(content)) return []
    return content
      .filter((c): c is Obj => isObj(c) && c.type === 'tool_use')
      .map(c => ({ type: 'step' as const, text: toolStep(str(c.name), isObj(c.input) ? c.input : {}, workdir) }))
  }
  if (line.type === 'result') {
    const text = clip(redact(str(line.result).trim()), SUMMARY_MAX)
    if (line.is_error === true) {
      // The model's own words when it gave any; otherwise a sentence the app writes from the CLI's status code.
      return text
        ? [{ type: 'error', source: 'provider', message: text }]
        : [{ type: 'error', source: 'system', message: `The agent stopped: ${str(line.subtype) || 'error'}.` }]
    }
    // total_cost_usd is deliberately dropped: it is an API-price estimate, not what a subscription pays.
    return [{ type: 'done', summary: text, source: 'provider', usage: { tokens: reportedTokens(line.usage) } }]
  }
  return []
}

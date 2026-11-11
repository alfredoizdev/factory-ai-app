import { askClaude, type AskModel } from '@/engine/branch-name'
import { strings } from '@/ui/strings'

// Choosing the builder's model by what the request is about. A block may name one model for front-end work and one
// for back-end work; a fast model reads the request and says which it is. Anything it cannot say plainly is
// "unknown", and then the block's ordinary model is used. The choice is always written on the card, never hidden.

export type Area = 'frontend' | 'backend' | 'both'
const AREAS: ReadonlySet<string> = new Set<Area>(['frontend', 'backend', 'both'])

export type RoutableBlock = { kind: string; model?: string; modelFrontend?: string; modelBackend?: string }

/** True when the block asks for a choice at all: only then is the request read. */
export function wantsRouting(block: RoutableBlock): boolean {
  return block.kind === 'build' && (block.modelFrontend !== undefined || block.modelBackend !== undefined)
}

/** One word from the model, accepted only when it is one of the three. Never throws. */
export async function classifyArea(request: string, ask: AskModel = askClaude): Promise<Area | null> {
  const prompt =
    'Is this software change request about the frontend (UI, pages, styles, components), the backend (APIs, server, ' +
    'database, jobs), or both? Reply with exactly one word: frontend, backend or both.\n' +
    `Request: ${request.slice(0, 2000)}`
  try {
    const word = (await ask(prompt)).trim().toLowerCase().replace(/[^a-z]/g, '')
    return AREAS.has(word) ? (word as Area) : null
  } catch {
    return null
  }
}

/**
 * The model this block runs with for that area, and the sentence that says so. Front end or back end uses its own
 * model when one is set; both, unknown, or an unset side falls back to the block's ordinary model (or the default).
 */
export function routeModel(block: RoutableBlock, area: Area | null): { model?: string; note: string } {
  const chosen = area === 'frontend' ? block.modelFrontend : area === 'backend' ? block.modelBackend : undefined
  const model = chosen ?? block.model
  const what = area === null ? strings.routing.unknown : strings.routing.area[area]
  return { ...(model !== undefined ? { model } : {}), note: strings.routing.note(what, model ?? strings.routing.defaultModel) }
}

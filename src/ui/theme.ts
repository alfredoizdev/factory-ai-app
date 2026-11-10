// Visual vocabulary for node states. Leaf module: imports nothing.
// The domain NodeState is mapped onto VisualState by the UI layer.
export type VisualState = 'running' | 'passed' | 'failed' | 'waiting' | 'skipped'

const colours = {
  bg: '#0b0e14',
  card: '#151a23',
  border: '#262d3a',
  running: '#3b82f6',
  passed: '#22c55e',
  failed: '#ef4444',
  waiting: '#f59e0b',
  skipped: '#6b7280',
  /** The floor grid lines under the canvas: quieter than a card border so they never compete with it. */
  floorLine: '#2a3548',
  /** The ring that points at a block when an event line says "point it out". */
  pointer: '#e5e7eb',
} as const

const glowRgb: Record<VisualState, string> = {
  running: '59, 130, 246',
  passed: '34, 197, 94',
  failed: '239, 68, 68',
  waiting: '245, 158, 11',
  skipped: '107, 114, 128',
}

export const theme = {
  ...colours,
  /** Drop shadow for a card lifted `level` steps off the floor (0 = resting). Decorative depth only. */
  elevation(level: 0 | 1 | 2): string {
    const lift = [0, 6, 14][level] ?? 0
    return level === 0 ? 'none' : `0 ${lift}px ${lift * 2}px rgba(0, 0, 0, 0.45)`
  },
  /** Soft colour pools on the floor; rgba of the running accent and the card tone. */
  ambient: 'radial-gradient(ellipse at 30% 40%, rgba(59, 130, 246, 0.10), transparent 55%), radial-gradient(ellipse at 75% 65%, rgba(245, 158, 11, 0.06), transparent 50%)',
  /** CSS box-shadow string for a node in the given visual state. */
  glow(state: VisualState): string {
    const rgb = glowRgb[state]
    return `0 0 0 1px rgba(${rgb}, 0.6), 0 0 18px rgba(${rgb}, 0.35)`
  },
}

// The brand's own look, set on the welcome screen and carried by the "New project" wizard: near-black, one green
// accent, quiet greys.
export const brand = {
  bg: '#111111',
  card: '#181818',
  line: '#2a2a2a',
  text: '#e8eaf0',
  quiet: '#a3a3a3',
  faint: '#8a8a8a',
  green: '#79dc8b',
  /** Text and marks drawn on the green. */
  onGreen: '#0d1f12',
  /** The green as a faint wash, behind something chosen. */
  greenWash: 'rgba(121, 220, 139, 0.1)',
  mono: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
} as const

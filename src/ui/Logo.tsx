/**
 * The app's mark: the steps every task takes, joined by a line, the last one filled — done and sent. The first two
 * steps take the colour of the text around them; the last takes `accent`.
 */
export function Logo({ size = 20, accent = '#79dc8b' }: { size?: number; accent?: string }) {
  return (
    <svg data-testid="app-logo" viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M9.6 16h2.8M19.6 16h2.8" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="6" cy="16" r="3.4" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="16" cy="16" r="3.4" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="26" cy="16" r="4.5" fill={accent} />
    </svg>
  )
}

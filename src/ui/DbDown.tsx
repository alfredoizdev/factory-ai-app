import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

/**
 * The page when the database cannot be reached: said plainly, never shown as an empty project (which would read as if
 * the work were gone). Reloading tries again.
 */
export function DbDown() {
  return (
    <main role="alert" data-testid="db-down" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: theme.bg, color: '#e6e9ef', padding: 24 }}>
      <div style={{ maxWidth: 460, display: 'grid', gap: 10, textAlign: 'center' }}>
        <h1 className="factory-display" style={{ margin: 0, fontSize: 24 }}>
          {strings.dbDown.title}
        </h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: theme.dim }}>{strings.dbDown.text}</p>
        <a href="." style={{ justifySelf: 'center', padding: '8px 16px', borderRadius: 8, background: theme.running, color: '#fff', fontWeight: 700, textDecoration: 'none' }}>
          {strings.dbDown.retry}
        </a>
      </div>
    </main>
  )
}

/** True for a failure to reach or use the database, as opposed to Next's own not-found or redirect signals. */
export function isDbFailure(e: unknown): boolean {
  const digest = (e as { digest?: unknown })?.digest
  return !(typeof digest === 'string' && digest.startsWith('NEXT_'))
}

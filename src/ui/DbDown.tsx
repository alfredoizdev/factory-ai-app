import { localDb } from '@/db/where'
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
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: theme.dim }}>{localDb() ? strings.dbDown.textLocal : strings.dbDown.text}</p>
        <a href="." style={{ justifySelf: 'center', padding: '8px 16px', borderRadius: 8, background: theme.running, color: '#fff', fontWeight: 700, textDecoration: 'none' }}>
          {strings.dbDown.retry}
        </a>
      </div>
    </main>
  )
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', '57P01', '57P03', '08000', '08001', '08003', '08006'])

/**
 * True when the database could not be reached (a connection error, or a server that is shutting down or not
 * accepting connections). Anything else, a bug included, is not hidden behind this page.
 */
export function isDbFailure(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && UNREACHABLE.has(code)) return true
    const message = String((cur as { message?: unknown }).message ?? '')
    if (/connection terminated|timeout expired|could not connect|Connection terminated unexpectedly/i.test(message)) return true
  }
  return false
}

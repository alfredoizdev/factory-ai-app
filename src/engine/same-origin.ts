import { strings } from '@/ui/strings'

// A local single-user app has no login, so the browser is the only thing standing between a page the person happens
// to visit and the mutating routes. A browser states where a request came from (Sec-Fetch-Site, Origin) and a page
// cannot change what it states. Both are checked when present; a request that carries neither did not come from a
// page (curl, a test, a server), and a page cannot produce one.
export function rejectCrossSite(req: Request): Response | null {
  // First, who the request was addressed to. Only a loopback name is this app: anything else arrived over the network
  // or through DNS rebinding, and a rebound page's Origin always matches its Host, so the checks below cannot see it.
  if (!isLoopbackHost(hostOf(req))) return refuse()

  const site = req.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return refuse()

  const origin = req.headers.get('origin')
  if (origin !== null) {
    const host = hostOf(req)
    let originHost: string | null = null
    try {
      originHost = new URL(origin).host
    } catch {
      // "null" (a sandboxed or redirected context) and anything unparseable are not this origin.
    }
    if (originHost !== host) return refuse()
  }
  return null
}

function refuse(): Response {
  return Response.json({ error: strings.errors.crossSite }, { status: 403 })
}

function hostOf(req: Request): string {
  return req.headers.get('host') ?? new URL(req.url).host
}

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for localhost, 127.0.0.1 and [::1], on any port. Exported for the proxy, which applies it to every request. */
export function isLoopbackHost(host: string): boolean {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!
  return LOOPBACK_NAMES.has(name.toLowerCase())
}

/**
 * Stricter than rejectCrossSite, for the human check: the request must come from this app's own page, which a
 * browser proves with fetch metadata. A request with no browser headers (a script, curl, a local agent) is refused
 * here even though rejectCrossSite would let it through. Forging the headers is possible for a local process, so this
 * is a guard against shortcuts, not against a determined one: the design says so (§8, the human gate).
 */
export function requireOwnPage(req: Request): Response | null {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  if (req.headers.get('sec-fetch-site') !== 'same-origin') {
    return Response.json({ error: strings.gate.browserOnly }, { status: 403 })
  }
  return null
}

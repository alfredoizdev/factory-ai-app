import { strings } from '@/ui/strings'

// A local single-user app has no login, so the browser is the only thing standing between a page the person happens
// to visit and the mutating routes. A browser states where a request came from (Sec-Fetch-Site, Origin) and a page
// cannot change what it states. Both are checked when present; a request that carries neither did not come from a
// page (curl, a test, a server), and a page cannot produce one.
export function rejectCrossSite(req: Request): Response | null {
  const site = req.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return refuse()

  const origin = req.headers.get('origin')
  if (origin !== null) {
    const host = req.headers.get('host') ?? new URL(req.url).host
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

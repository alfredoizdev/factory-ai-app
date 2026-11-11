import { NextResponse, type NextRequest } from 'next/server'
import { isLoopbackHost } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

// Every request, reads included, must be addressed to a loopback name. The pages and read routes show a project's
// repository path, its runs and their output; a page reached by DNS rebinding could otherwise read all of it. The
// mutating routes also check this themselves (rejectCrossSite), so neither layer depends on the other.
export function proxy(request: NextRequest) {
  const host = request.headers.get('host') ?? request.nextUrl.host
  if (!isLoopbackHost(host)) return NextResponse.json({ error: strings.errors.notLocal }, { status: 403 })
  return NextResponse.next()
}

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/engine/snapshots', () => ({ readSnapshot: vi.fn(async () => new Uint8Array([1, 2, 3])) }))

import { GET } from '@/app/api/runs/[runId]/snapshots/[shot]/route'

const ctx = { params: Promise.resolve({ runId: '01M7AXAGCSTK02F6TQ98SREPBJ', shot: 'after-desktop' }) }
const at = (q: string) => new Request(`http://127.0.0.1:4100/api/runs/01M7AXAGCSTK02F6TQ98SREPBJ/snapshots/after-desktop${q}`)

describe('one picture', () => {
  it('may be kept by the browser when its address says which taking it is from', async () => {
    const res = await GET(at('?v=12'), ctx)
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('is read again each time when its address does not say', async () => {
    const res = await GET(at(''), ctx)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

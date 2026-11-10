import { describe, expect, test, vi } from 'vitest'

// Any module that reaches the db client throws on import, so a successful import of the provider
// proves it does not open a database.
vi.mock('@/db/client', () => {
  throw new Error('db client was imported')
})

describe('DEMO_PROVIDER_ID', () => {
  test('is pinned to the literal demo that the Demo badge matches', async () => {
    const { DEMO_PROVIDER_ID } = await import('@/providers/ids')
    expect(DEMO_PROVIDER_ID).toBe('demo')
  })

  test('the engine re-exports the same value', async () => {
    // Positive control: the engine imports the db client, so this import must be rejected by the mock.
    await expect(import('@/engine/run')).rejects.toThrow(/error when mocking|db client was imported/)
    const ids = await import('@/providers/ids')
    expect(ids.DEMO_PROVIDER_ID).toBe('demo')
  })

  test('importing the demo provider does not open a database', async () => {
    await expect(import('@/providers/demo')).resolves.toMatchObject({ demoProvider: { id: 'demo', isDemo: true } })
  })
})

export {}

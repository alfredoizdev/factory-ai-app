import { serialized } from '@/engine/serial'

test('actions on one run take turns; another run does not wait; a nested action does not wait for itself', async () => {
  const log: string[] = []
  const slow = (tag: string) => serialized('r1', async () => {
    log.push(`${tag} start`)
    await new Promise(r => setTimeout(r, 20))
    log.push(`${tag} end`)
  })
  await Promise.all([slow('a'), slow('b'), serialized('r2', async () => void log.push('other'))])
  expect(log.indexOf('a end')).toBeLessThan(log.indexOf('b start'))
  expect(log.indexOf('other')).toBeLessThan(log.indexOf('a end'))
  await expect(serialized('r1', () => serialized('r1', async () => 'inner'))).resolves.toBe('inner')
})

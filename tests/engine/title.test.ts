import { cleanTitle } from '@/engine/title'

test('a title is one clean line, bounded', () => {
  expect(cleanTitle('"Borde del escudo."\nmore')).toBe('Borde del escudo')
  expect(cleanTitle('Title: Thicker border')).toBe('Thicker border')
  expect(cleanTitle('   ')).toBeNull()
  expect(cleanTitle('x'.repeat(200))!.length).toBeLessThanOrEqual(60)
})

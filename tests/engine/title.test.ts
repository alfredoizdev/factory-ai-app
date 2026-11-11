import { cleanTitle, fallbackTitle, suggestTitle } from '@/engine/title'

test('a quick title is the request\'s first clause, without bracketed paths, cut at a word', () => {
  expect(fallbackTitle('En la portada (src/app/page.tsx), añade un borde circular alrededor del escudo del centro. Luego más.')).toBe('En la portada, añade un borde circular alrededor')
  expect(fallbackTitle('make it blue')).toBe('Make it blue')
})

test('a title is one clean line, bounded', () => {
  expect(cleanTitle('"Borde del escudo."\nmore')).toBe('Borde del escudo')
  expect(cleanTitle('Title: Thicker border')).toBe('Thicker border')
  expect(cleanTitle('   ')).toBeNull()
  expect(cleanTitle('x'.repeat(200))!.length).toBeLessThanOrEqual(60)
})

test('a suggestion that fails or says nothing is no title', async () => {
  expect(await suggestTitle('r', async () => 'Borde más grueso')).toBe('Borde más grueso')
  expect(await suggestTitle('r', async () => '')).toBeNull()
  expect(await suggestTitle('r', async () => { throw new Error('no claude') })).toBeNull()
})

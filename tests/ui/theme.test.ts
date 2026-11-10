import { theme } from '@/ui/theme'
test('every node state has a colour and a glow', () => {
  for (const s of ['running','passed','failed','waiting','skipped'] as const) {
    expect(theme[s]).toMatch(/^#|^rgb/)
    expect(theme.glow(s)).toContain('rgba')
  }
})

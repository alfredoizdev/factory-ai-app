import { askModeOf, passesLowRisk, shipsOnItsOwn } from '@/domain/ask-mode'

test.each([
  [{ askMode: null, autoApproveLowRisk: true }, 'small_changes'],
  [{ askMode: null, autoApproveLowRisk: false }, 'everything'],
  [{ askMode: 'what_matters', autoApproveLowRisk: false }, 'what_matters'],
  [{ askMode: 'nonsense', autoApproveLowRisk: true }, 'everything'],
] as const)('the mode of %j is %s', (row, mode) => {
  expect(askModeOf(row)).toBe(mode)
})

test('the final check opens on its own only for the two lenient modes and only when the person did not ask to stop', () => {
  expect(passesLowRisk('what_matters', false)).toBe(true)
  expect(passesLowRisk('small_changes', false)).toBe(true)
  expect(passesLowRisk('everything', false)).toBe(false)
  for (const mode of ['what_matters', 'small_changes', 'everything'] as const) expect(passesLowRisk(mode, true)).toBe(false)
})

test('only "what matters" without a stop request ships on its own', () => {
  expect(shipsOnItsOwn('what_matters', false)).toBe(true)
  expect(shipsOnItsOwn('what_matters', true)).toBe(false)
  expect(shipsOnItsOwn('small_changes', false)).toBe(false)
  expect(shipsOnItsOwn('everything', false)).toBe(false)
})

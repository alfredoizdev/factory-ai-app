import { explained, type Touched } from '@/ui/explain'
import { strings } from '@/ui/strings'

// A register number in a sentence reads as what the person knows it by: never as a bare code, never as a deleted
// decision when the entry is there, and without the word before it said twice.

const core: Touched = { number: 3, label: 'D-03', kind: 'core', text: 'Ask me before changing src/app/', paths: ['src/app/'] }
const decision: Touched = { number: 7, label: 'D-07', kind: 'decision', text: 'Tokens are never written to the log', paths: [] }
const rule: Touched = { number: 2, label: 'D-02', kind: 'rule', text: 'Buttons are always blue', paths: [] }

test('the verifier\'s sentence about an existing core area names the area, and the word before it is not doubled', () => {
  expect(explained('Decision D-03 appears nowhere in the repo', [core])).toBe('Your core area src/app/ appears nowhere in the repo')
})

test('the reviewer\'s sentence reads the same way', () => {
  expect(
    explained('The change edits a file under src/app/, and agreed decision D-03 says to ask before changing src/app/. There is no sign that permission was asked or given. The code itself is correct.', [core]),
  ).toBe('The change edits a file under src/app/, and your core area src/app/ says to ask before changing src/app/. There is no sign that permission was asked or given. The code itself is correct.')
})

test('a decision and a rule read as their own words, in quotes, clipped when long', () => {
  expect(explained('It touches a decision you made (D-07).', [decision])).toBe('It touches a decision you made (your decision “Tokens are never written to the log”).')
  expect(explained('Rule D-02 is not followed.', [rule])).toBe('Your rule “Buttons are always blue” is not followed.')
  const long = { ...decision, text: 'x'.repeat(200) }
  const out = explained('See D-07.', [long])
  expect(out.length).toBeLessThan(120)
  expect(out).toContain('…')
})

test('only a number with no entry at all reads as an earlier decision, also without a doubled word', () => {
  expect(explained('Decision D-03 appears nowhere in the repo', [])).toBe('An earlier decision of yours appears nowhere in the repo')
  expect(explained('It touches a decision you made (D-09).', [core])).toBe(`It touches a decision you made (${strings.question.earlierDecision}).`)
})

test('no register number is left bare', () => {
  expect(explained('D-03 and decision D-07 and D-99', [core, decision])).not.toMatch(/D-\d/)
})

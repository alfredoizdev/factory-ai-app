// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { FindingsList } from '@/ui/canvas/FindingsList'
import type { FindingView } from '@/engine/finding-view'
import { strings } from '@/ui/strings'

const view = (over: Partial<FindingView> = {}): FindingView => ({
  id: 'f1', title: strings.findings.title.logic, type: 'logic', state: 'corrected', ending: 'fixed', outcome: strings.findings.ended.fixedChecked, how: 'checked',
  detail: { where: 'src/app/page.tsx:12', problem: 'The button never renders.', command: 'node check-button.js', outputTail: 'BUTTON-MISSING', reason: strings.findings.fixedChecked },
  ...over,
})
const three: FindingView[] = [
  view({ id: 'a' }),
  view({ id: 'b', ending: 'needs_you', state: 'open', how: 'not_checked', outcome: strings.findings.ended.open, title: strings.findings.title.security, type: 'security' }),
  view({ id: 'c', ending: 'set_aside', state: 'refuted', how: 'ai', outcome: strings.findings.ended.checkerNotThere }),
]

test('groups as Fixed, Needs you and Set aside, each problem with how it ended in plain words', () => {
  render(<FindingsList findings={three} />)
  for (const g of ['Fixed', 'Needs you', 'Set aside']) expect(screen.getByRole('heading', { name: new RegExp(`^${g}`) })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /Being checked/ })).toBeNull()
  expect(screen.getByText(strings.findings.ended.fixedChecked)).toBeInTheDocument()
  expect(screen.getByText(strings.findings.ended.open)).toBeInTheDocument()
  expect(screen.getByText(strings.findings.ended.checkerNotThere)).toBeInTheDocument()
})

test('the words "discarded", "finding" and "repro" are not on the first level', () => {
  render(<FindingsList findings={three} />)
  expect(document.body.textContent).not.toMatch(/discard|finding|repro|diff|commit/i)
})

test('each is marked "The app checked it", "AI says so" or "Not checked", three visibly different marks', () => {
  render(<FindingsList findings={three} />)
  const marks = screen.getAllByTestId('how-mark')
  expect(marks.map(m => m.getAttribute('data-state')).sort()).toEqual(['ai', 'checked', 'not_checked'])
  expect(marks.map(m => m.textContent).sort()).toEqual([strings.findings.how.ai, strings.findings.how.checked, strings.findings.how.not_checked].sort())
  // not by colour alone: each carries its own icon shape
  const shapes = marks.map(m => m.querySelector('svg')?.innerHTML)
  expect(new Set(shapes).size).toBe(3)
})

test('file, line, command and output appear only after See details is opened', () => {
  render(<FindingsList findings={[view()]} />)
  expect(document.body.textContent).not.toMatch(/page\.tsx|check-button|BUTTON-MISSING|never renders/)
  const button = screen.getByRole('button', { name: strings.question.seeDetails })
  expect(button).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(button)
  expect(button).toHaveAttribute('aria-expanded', 'true')
  const text = document.body.textContent ?? ''
  for (const t of ['src/app/page.tsx:12', 'node check-button.js', 'BUTTON-MISSING', 'The button never renders.']) expect(text).toContain(t)
  // the reviewer's words are labelled as the AI's
  const said = screen.getByText(strings.findings.detail.aiSaid)
  expect(said.parentElement).toHaveTextContent('The button never renders.')
})

test('with no findings it says so and shows no empty headings', () => {
  render(<FindingsList findings={[]} />)
  expect(screen.getByText(strings.findings.none)).toBeInTheDocument()
  expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0)
})

test('a group with nothing in it has no heading', () => {
  render(<FindingsList findings={[view()]} />)
  expect(screen.getByRole('heading', { name: /^Fixed/ })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /Needs you/ })).toBeNull()
  expect(within(screen.getByRole('heading', { name: /^Fixed/ })).getByText('1')).toBeInTheDocument()
})

test('a short legend in plain words says what the three marks mean, as text on the page', () => {
  render(<FindingsList findings={three} />)
  for (const how of ['checked', 'ai', 'not_checked'] as const) {
    expect(screen.getByText(strings.findings.howMeans[how], { selector: '[data-testid="legend"] *' })).toBeInTheDocument()
  }
  expect(screen.getByTestId('legend')).toHaveTextContent(strings.findings.how.ai)
})

test('problems with the same title are told apart by a number, in the order shown', () => {
  render(<FindingsList findings={[view({ id: 'a', ending: 'set_aside' }), view({ id: 'b', ending: 'needs_you' }), view({ id: 'c', ending: 'needs_you' })]} />)
  const rows = screen.getAllByTestId('finding')
  expect(rows.map(r => within(r).getByTestId('finding-number').textContent)).toEqual([strings.findings.number(1), strings.findings.number(2), strings.findings.number(3)])
  expect(rows[2]).toHaveTextContent(strings.findings.ended.fixedChecked) // the set-aside one is last and carries 3
})

test('a register number in a reason is never shown bare', () => {
  render(<FindingsList findings={[view({ detail: { where: '', problem: '', command: '', outputTail: '', reason: 'It touches a decision you made (D-07).' } })]} />)
  fireEvent.click(screen.getByRole('button', { name: strings.question.seeDetails }))
  expect(document.body.textContent).not.toMatch(/D-\d/)
})

test('an entry number reads the same in what the reviewer said and in why it ended', () => {
  const touched = [{ number: 3, label: 'D-03', kind: 'core', text: 'Ask me before changing src/app/', paths: ['src/app/'] }]
  const problem = 'The change edits a file under src/app/, and agreed decision D-03 says to ask before changing src/app/.'
  render(<FindingsList touched={touched} findings={[view({ detail: { where: '', problem, command: '', outputTail: '', reason: 'Decision D-03 appears nowhere in the repo' } })]} />)
  fireEvent.click(screen.getByRole('button', { name: strings.question.seeDetails }))
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(/D-\d/)
  expect(text).toContain('and your core area src/app/ says to ask')
  expect(text).toContain('Your core area src/app/ appears nowhere in the repo')
  expect(text).not.toContain(strings.question.earlierDecision)
})

test('the legend shows only the marks the list uses', () => {
  render(<FindingsList findings={[view({ id: 'a' }), view({ id: 'b', how: 'checked' })]} />)
  const legend = screen.getByTestId('legend')
  expect(legend).toHaveTextContent(strings.findings.howMeans.checked)
  expect(legend).not.toHaveTextContent(strings.findings.howMeans.ai)
  expect(legend).not.toHaveTextContent(strings.findings.howMeans.not_checked)
})

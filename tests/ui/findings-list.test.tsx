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

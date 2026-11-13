// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '@/ui/Welcome'
import { strings } from '@/ui/strings'

const w = strings.welcome

test('with no project yet, the app says what it does, the path of a task and what it can do', () => {
  render(<Welcome />)
  expect(screen.getByRole('heading', { level: 1, name: `${w.titleLead} ${w.titleRest}` })).toBeInTheDocument()
  expect(screen.getByTestId('welcome-steps').querySelectorAll('li')).toHaveLength(w.steps.length)
  expect(screen.getByTestId('welcome-can').querySelectorAll('article')).toHaveLength(w.can.length)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('each way to start opens the wizard already on that way, past the first screen', () => {
  const { unmount } = render(<Welcome />)
  fireEvent.click(screen.getByTestId('welcome-scratch'))
  expect(screen.getByRole('dialog', { name: strings.wizard.title })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: strings.wizard.build.lead })).toBeInTheDocument()
  // Back still reaches the first screen, where the other way can be picked.
  fireEvent.click(screen.getByRole('button', { name: strings.wizard.back }))
  expect(screen.getByTestId('way-scratch')).toHaveAttribute('aria-pressed', 'true')
  unmount()
  render(<Welcome />)
  fireEvent.click(screen.getByTestId('welcome-existing'))
  expect(screen.getByLabelText(strings.setup.folder)).toBeInTheDocument()
})

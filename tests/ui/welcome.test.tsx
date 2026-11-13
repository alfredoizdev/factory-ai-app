// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '@/ui/Welcome'
import { strings } from '@/ui/strings'

test('with no project yet, the app says what it is and its one button opens the "New project" wizard', () => {
  render(<Welcome />)
  expect(screen.getByRole('heading', { name: strings.welcome.title })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.projectSwitcher.add) }))
  expect(screen.getByRole('dialog', { name: strings.wizard.title })).toBeInTheDocument()
  expect(screen.getByTestId('way-scratch')).toBeInTheDocument()
})

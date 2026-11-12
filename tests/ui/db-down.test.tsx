// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { DbDown, isDbFailure } from '@/ui/DbDown'
import { strings } from '@/ui/strings'

test('when the database cannot be reached the page says so, and offers to try again', () => {
  render(<DbDown />)
  expect(screen.getByRole('alert')).toHaveTextContent(strings.dbDown.title)
  expect(screen.getByRole('link', { name: strings.dbDown.retry })).toBeInTheDocument()
})

test('Next\'s own signals (not found, redirect) are not database failures', () => {
  expect(isDbFailure(Object.assign(new Error('x'), { digest: 'NEXT_NOT_FOUND' }))).toBe(false)
  expect(isDbFailure(Object.assign(new Error('x'), { digest: 'NEXT_REDIRECT;replace;/x;307;' }))).toBe(false)
  expect(isDbFailure(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) }))).toBe(true)
  // A bug is not dressed up as an outage.
  expect(isDbFailure(new SyntaxError('Unexpected token'))).toBe(false)
})

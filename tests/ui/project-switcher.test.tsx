// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { ProjectSwitcher } from '@/ui/canvas/ProjectSwitcher'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const projects = [{ projectId: 'p1', name: 'comets-web', repoPath: '/r', workflowId: 'w1', baseStatus: 'ready', baseMessage: null }]

test('the project menu closes on a click anywhere outside it, even where the canvas swallows clicks, and on Escape', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projects }))))
  render(
    <>
      <ProjectSwitcher workflowId="w1" style={{}} />
      <div data-testid="canvas" onPointerDown={e => e.stopPropagation()} />
    </>,
  )
  const toggle = await screen.findByRole('button', { name: /comets-web/ })
  fireEvent.click(toggle)
  expect(screen.getByRole('menu')).toBeInTheDocument()
  fireEvent.pointerDown(screen.getByTestId('canvas'))
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(toggle)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  // A click inside it does not close it.
  fireEvent.click(toggle)
  fireEvent.pointerDown(screen.getByText(strings.projectSwitcher.thisProject))
  expect(screen.getByRole('menu')).toBeInTheDocument()
})

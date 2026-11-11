// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { defaultGraph } from '@/domain/graph'
import { CanvasScreen } from '@/ui/canvas/CanvasScreen'
import { strings } from '@/ui/strings'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
beforeEach(() => window.localStorage.clear())

const settings = { projectId: 'p1', repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: false }
const page = () => render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={settings} />)

test('the request is a large box in the sidebar, which starts open', () => {
  page()
  const box = screen.getByLabelText(strings.run.requestLabel)
  expect(box.tagName).toBe('TEXTAREA')
  expect(screen.getByTestId('sidebar')).toBeVisible()
  expect(screen.queryByTestId('sidebar-rail')).toBeNull()
})

test('closing the sidebar leaves a rail of named icons, and the choice is remembered', () => {
  const { unmount } = page()
  fireEvent.click(screen.getByRole('button', { name: strings.sidebar.close }))
  const rail = screen.getByTestId('sidebar-rail')
  for (const name of [strings.sidebar.open, strings.sidebar.run, strings.editing.paletteTitle, strings.editing.inspectorTitle]) {
    expect(rail.querySelector(`[aria-label="${name}"]`)).not.toBeNull()
  }
  expect(screen.getByTestId('sidebar')).not.toBeVisible()
  unmount()
  page()
  expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument()
})

test('the run icon opens the sidebar with the cursor in the request box', async () => {
  page()
  fireEvent.click(screen.getByRole('button', { name: strings.sidebar.close }))
  fireEvent.click(screen.getByRole('button', { name: strings.sidebar.run }))
  await act(() => new Promise(r => requestAnimationFrame(() => r(undefined))))
  expect(screen.getByTestId('sidebar')).toBeVisible()
  expect(document.activeElement).toBe(screen.getByLabelText(strings.run.requestLabel))
})

test('Cmd+Enter in the request box starts a run; an empty box does not', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    page()
    const box = screen.getByLabelText(strings.run.requestLabel)
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: 'make it blue' } })
    await act(async () => void fireEvent.keyDown(box, { key: 'Enter', metaKey: true }))
    expect(fetchMock).toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

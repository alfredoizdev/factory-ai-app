// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { defaultGraph } from '@/domain/graph'
import { CanvasScreen } from '@/ui/canvas/CanvasScreen'
import { strings } from '@/ui/strings'

// The past-tasks list and the project switcher read when the page opens; they are answered here, so a test's own mock sees only
// the requests it is about.
function stubFetch(mock: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    String(url).endsWith('/runs') && !init?.method
      ? Promise.resolve(new Response('{"runs":[]}'))
      : String(url) === '/api/projects' && !init?.method
        ? Promise.resolve(new Response('{"projects":[]}'))
        : mock(url, init),
  )
}


beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
beforeEach(() => window.localStorage.clear())

const settings = { projectId: 'p1', repoPath: '/repo', testCommand: 'npm test', askMode: 'everything' as const, currentBranch: null, defaultBranch: null }
const page = () => render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={settings} />)

test('the request is a large box in the command card, and the sidebar starts open', () => {
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

test('the run icon puts the cursor in the request box, which lives on the canvas', () => {
  page()
  fireEvent.click(screen.getByRole('button', { name: strings.sidebar.close }))
  fireEvent.click(screen.getByRole('button', { name: strings.sidebar.run }))
  expect(document.activeElement).toBe(screen.getByLabelText(strings.run.requestLabel))
  expect(screen.getByTestId('command-card')).toContainElement(screen.getByLabelText(strings.run.requestLabel))
})

test('Cmd+Enter in the request box starts a run; an empty box does not', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  stubFetch(fetchMock)
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

test('the run\'s log lives in the sidebar, and the closed rail has a way back to it', () => {
  // A run on screen opens its live stream; this one never sends anything.
  vi.stubGlobal('EventSource', class {
    onopen = null
    onmessage = null
    onerror = null
    close() {}
  })
  const run = { runId: 'r1', providerId: 'demo', blocks: defaultGraph().blocks }
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={settings} run={run} />)
  expect(screen.getByTestId('sidebar')).toContainElement(screen.getByTestId('event-bar'))
  fireEvent.click(screen.getByRole('button', { name: strings.sidebar.close }))
  expect(screen.getByTestId('sidebar-rail').querySelector(`[aria-label="${strings.events.barTitle}"]`)).not.toBeNull()
  vi.unstubAllGlobals()
})

test('without a run there is no log, and no rail icon for one', () => {
  page()
  expect(screen.queryByTestId('event-bar')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: strings.sidebar.close }))
  expect(screen.getByTestId('sidebar-rail').querySelector(`[aria-label="${strings.events.barTitle}"]`)).toBeNull()
})

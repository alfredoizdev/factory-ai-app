// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { PastTasks, whenText } from '@/ui/canvas/PastTasks'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const runs = [
  { runId: 'r2', request: 'Remove the white circle', status: 'completed', createdAt: new Date().toISOString(), branch: 'ai/crest', providerId: 'claude', parentRunId: null },
  { runId: 'r1', request: 'Outline the buttons', status: 'failed', createdAt: '2026-11-01T10:00:00Z', branch: null, providerId: 'demo', parentRunId: null },
]

test('lists past tasks with how each ended, marks the open one, and opens one on click', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs }))))
  const onOpen = vi.fn()
  render(<PastTasks workflowId="w1" currentRunId="r2" refreshKey="x" onOpen={onOpen} />)
  expect(await screen.findByText('Remove the white circle')).toBeInTheDocument()
  expect(screen.getByTestId('past-task-r2')).toHaveAttribute('aria-current', 'true')
  expect(screen.getByTestId('past-task-r1')).toHaveTextContent(strings.run.status.failed)
  expect(screen.getByTestId('past-task-r1')).toHaveTextContent(strings.history.demo)
  fireEvent.click(screen.getByTestId('past-task-r1'))
  expect(onOpen).toHaveBeenCalledWith('r1')
})

test('each task shows its name as a label, with what was asked under it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs: [{ ...runs[0], title: 'Crest circle' }] }))))
  render(<PastTasks workflowId="w1" currentRunId={null} refreshKey="x" onOpen={() => {}} />)
  expect(await screen.findByTestId('task-name-r2')).toHaveTextContent('Crest circle')
  expect(screen.getByText('Remove the white circle')).toBeInTheDocument()
})

test('an empty history says so', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs: [] }))))
  render(<PastTasks workflowId="w1" currentRunId={null} refreshKey="x" onOpen={() => {}} />)
  expect(await screen.findByText(strings.history.empty)).toBeInTheDocument()
})

test('times read as people say them', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  expect(whenText('2026-11-11T11:59:40Z', now)).toBe(strings.history.justNow)
  expect(whenText('2026-11-11T11:45:00Z', now)).toBe(strings.history.minutesAgo(15))
  expect(whenText('2026-11-11T09:00:00Z', now)).toBe(strings.history.hoursAgo(3))
  expect(whenText('2026-11-10T09:00:00Z', now)).toBe(strings.history.yesterday)
})

test('deleting asks first, on the spot, and removes the task only on yes', async () => {
  const fetchMock = vi.fn(async (_u: string, init?: RequestInit) =>
    init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ runs })))
  vi.stubGlobal('fetch', fetchMock)
  const onDeleted = vi.fn()
  render(<PastTasks workflowId="w1" currentRunId="r2" refreshKey="x" onOpen={() => {}} onDeleted={onDeleted} />)
  fireEvent.click(await screen.findByLabelText(strings.history.delete('Outline the buttons')))
  fireEvent.click(screen.getByRole('button', { name: strings.history.no }))
  expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false)
  fireEvent.click(screen.getByLabelText(strings.history.delete('Outline the buttons')))
  fireEvent.click(screen.getByRole('button', { name: strings.history.yes }))
  await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledWith('r1'))
  expect(screen.queryByText('Outline the buttons')).toBeNull()
})

test('a refused delete says why and keeps the task', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) =>
    init?.method === 'DELETE' ? new Response(JSON.stringify({ error: strings.history.stillLive }), { status: 409 }) : new Response(JSON.stringify({ runs }))))
  render(<PastTasks workflowId="w1" currentRunId={null} refreshKey="x" onOpen={() => {}} />)
  fireEvent.click(await screen.findByLabelText(strings.history.delete('Remove the white circle')))
  fireEvent.click(screen.getByRole('button', { name: strings.history.yes }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.history.stillLive)
  expect(screen.getByText('Remove the white circle')).toBeInTheDocument()
})

test('the Tasks button slides the drawer open; the backdrop, the ✕ and Escape close it', async () => {
  const { TasksDrawer } = await import('@/ui/canvas/TasksDrawer')
  const { useState } = await import('react')
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>{strings.history.open}</button>
        <TasksDrawer open={open} onClose={() => setOpen(false)}>
          <p>list</p>
        </TasksDrawer>
      </>
    )
  }
  render(<Harness />)
  const drawer = screen.getByTestId('tasks-drawer')
  expect(drawer).toHaveAttribute('data-open', 'false')
  fireEvent.click(screen.getByRole('button', { name: strings.history.open }))
  expect(drawer).toHaveAttribute('data-open', 'true')
  fireEvent.click(screen.getByTestId('tasks-backdrop'))
  expect(drawer).toHaveAttribute('data-open', 'false')
  fireEvent.click(screen.getByRole('button', { name: strings.history.open }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(drawer).toHaveAttribute('data-open', 'false')
  fireEvent.click(screen.getByRole('button', { name: strings.history.open }))
  fireEvent.click(screen.getByRole('button', { name: strings.history.close, hidden: true }))
  expect(drawer).toHaveAttribute('data-open', 'false')
})

test('with no task open the canvas says so and offers the past tasks', async () => {
  const { CanvasScreen } = await import('@/ui/canvas/CanvasScreen')
  const { defaultGraph } = await import('@/domain/graph')
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs }))))
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} />)
  expect(screen.getByTestId('no-task')).toHaveTextContent(strings.history.noTaskTitle)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.history.openPast) }))
  expect(screen.getByTestId('tasks-drawer')).toHaveAttribute('data-open', 'true')
  // Creating one instead: the card becomes the new-task help, above the flow.
  fireEvent.click(screen.getByRole('button', { name: strings.history.createOne }))
  expect(screen.getByTestId('no-task')).toHaveTextContent(strings.history.newTaskTitle)
})

test('a task whose pull request is on hold says so instead of its status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs: [{ ...runs[0], onHold: true }, { ...runs[1], onHold: false }] }))))
  render(<PastTasks workflowId="w1" currentRunId={null} refreshKey="x" onOpen={() => {}} />)
  expect(await screen.findByTestId('on-hold-r2')).toHaveTextContent(strings.history.onHold)
  expect(screen.getByTestId('past-task-r2')).not.toHaveTextContent(strings.run.status.completed)
  expect(screen.queryByTestId('on-hold-r1')).toBeNull()
})

test('a project with no task at all invites the first one, and its button puts the cursor in the request box', async () => {
  const { CanvasScreen } = await import('@/ui/canvas/CanvasScreen')
  const { defaultGraph } = await import('@/domain/graph')
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs: [] }))))
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} noTasksYet />)
  const card = screen.getByTestId('no-task')
  expect(card).toHaveTextContent(strings.history.firstTaskTitle)
  expect(screen.queryByRole('button', { name: new RegExp(strings.history.openPast) })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: strings.history.firstTaskAction }))
  expect(document.activeElement?.tagName).toBe('TEXTAREA')
})

test('tests that arrived after the project was added are offered, and saved only on a yes', async () => {
  const { CanvasScreen } = await import('@/ui/canvas/CanvasScreen')
  const { defaultGraph } = await import('@/domain/graph')
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const settings = { projectId: 'p1', repoPath: '/repo', testCommand: null, askMode: 'everything' as const, currentBranch: 'main', defaultBranch: 'main', suggestedTestCommand: 'npm test' }
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/p1' && init?.method === 'PUT') return new Response(JSON.stringify({ ...settings, testCommand: 'npm test', suggestedTestCommand: null }))
    return new Response(JSON.stringify({ runs: [] }))
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={settings} />)
  expect(screen.getByTestId('test-suggestion')).toHaveTextContent(strings.testSuggestion.text('npm test'))
  fireEvent.click(screen.getByRole('button', { name: strings.testSuggestion.accept }))
  await vi.waitFor(() => expect(screen.queryByTestId('test-suggestion')).toBeNull())
  const put = fetchMock.mock.calls.find(([u, i]) => u === '/api/projects/p1' && i?.method === 'PUT')!
  expect(JSON.parse(String(put[1]!.body))).toEqual({ testCommand: 'npm test' })
})

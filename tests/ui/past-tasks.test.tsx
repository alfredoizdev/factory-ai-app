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

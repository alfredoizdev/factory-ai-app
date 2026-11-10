// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { defaultGraph } from '@/domain/graph'
import { Canvas } from '@/ui/canvas/Canvas'

function matchMediaMock(query: string, matches: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === query ? matches : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => vi.unstubAllGlobals())

const running = [{ blockId: 'build', state: 'running' as const, summary: '', summaryIsClaim: false, steps: [] }]

test('particles run only on cables feeding a running block', async () => {
  render(<Canvas graph={defaultGraph()} runBlocks={defaultGraph().blocks} nodeRuns={running} />)
  expect(await screen.findByTestId('particles-plan->build')).toBeInTheDocument()
  expect(screen.queryByTestId('particles-build->tests')).toBeNull()
  expect(screen.queryByTestId('particles-input->plan')).toBeNull()
})

test('no particles when nothing is running', async () => {
  const idle = [{ ...running[0]!, state: 'passed' as const }]
  render(<Canvas graph={defaultGraph()} runBlocks={defaultGraph().blocks} nodeRuns={idle} />)
  await screen.findByTestId('node-build')
  expect(screen.queryByTestId('particles-plan->build')).toBeNull()
})

test('the depth layer is decorative and never captures clicks', () => {
  render(<Canvas graph={defaultGraph()} />)
  const floor = screen.getByTestId('depth-floor')
  expect(floor).toHaveAttribute('aria-hidden', 'true')
  expect(getComputedStyle(floor).pointerEvents).toBe('none')
  expect(getComputedStyle(screen.getByTestId('depth')).pointerEvents).toBe('none')
})

test('motion is dropped when the user asks for reduced motion', async () => {
  matchMediaMock('(prefers-reduced-motion: reduce)', true)
  render(<Canvas graph={defaultGraph()} runBlocks={defaultGraph().blocks} nodeRuns={running} />)
  expect(await screen.findByTestId('node-build')).toHaveAttribute('data-state', 'running')
  expect(screen.queryByTestId('particles-plan->build')).toBeNull()
  // The meaning survives without motion: the card still says running.
  expect(screen.getByTestId('node-build')).toHaveTextContent(/running/i)
})

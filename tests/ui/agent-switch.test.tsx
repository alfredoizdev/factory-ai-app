// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
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

const noRepo = { projectId: 'p1', repoPath: null, testCommand: null }
const withRepo = { projectId: 'p1', repoPath: '/repo', testCommand: 'npm test' }
const runButton = () => screen.getByRole('button', { name: strings.run.run })

test('the demo is the default, and choosing Claude shows where it works and that it is not sandboxed', () => {
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={noRepo} />)
  expect(screen.getByLabelText(strings.settings.agentLabel)).toHaveValue('demo')
  expect(screen.queryByTestId('agent-settings')).toBeNull()
  fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
  expect(screen.getByTestId('agent-settings')).toBeInTheDocument()
  expect(screen.getByText(strings.settings.notSandboxed)).toBeInTheDocument()
})

test('Claude cannot be run until the project has a repository', () => {
  const { unmount } = render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={noRepo} />)
  fireEvent.change(screen.getByLabelText(strings.run.requestLabel), { target: { value: 'make it blue' } })
  fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
  expect(runButton()).toBeDisabled()
  unmount()
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={withRepo} />)
  fireEvent.change(screen.getByLabelText(strings.run.requestLabel), { target: { value: 'make it blue' } })
  fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
  expect(runButton()).toBeEnabled()
  expect(screen.getByLabelText(strings.settings.repoLabel)).toHaveValue('/repo')
})

test('without project settings there is no agent switch at all', () => {
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} />)
  expect(screen.queryByLabelText(strings.settings.agentLabel)).toBeNull()
})

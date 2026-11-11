// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
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

const noRepo = { projectId: 'p1', repoPath: null, testCommand: null, autoApproveLowRisk: false, currentBranch: null, defaultBranch: null }
const withRepo = { projectId: 'p1', repoPath: '/repo', testCommand: 'npm test', autoApproveLowRisk: false, currentBranch: null, defaultBranch: null }
const runButton = () => screen.getByRole('button', { name: strings.run.run })

test('the demo is the default without a folder; the project settings open in their own window, saying Claude is not sandboxed', () => {
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={noRepo} />)
  expect(screen.getByLabelText(strings.settings.agentLabel)).toHaveValue('demo')
  expect(screen.queryByTestId('agent-settings')).toBeNull()
  fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
  fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
  expect(screen.getByTestId('agent-settings')).toBeInTheDocument()
  expect(screen.getByText(strings.settings.notSandboxed)).toBeInTheDocument()
})

test('Claude cannot be run until the project has a repository', () => {
  const { unmount } = render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={noRepo} />)
  fireEvent.change(screen.getByLabelText(strings.run.requestLabel), { target: { value: 'make it blue' } })
  fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
  fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
  expect(runButton()).toBeDisabled()
  unmount()
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={withRepo} />)
  fireEvent.change(screen.getByLabelText(strings.run.requestLabel), { target: { value: 'make it blue' } })
  fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
  fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
  expect(runButton()).toBeEnabled()
  expect(screen.getByLabelText(strings.settings.repoLabel)).toHaveValue('/repo')
})

test('without project settings there is no agent switch at all', () => {
  render(<CanvasScreen workflowId="w1" graph={defaultGraph()} />)
  expect(screen.queryByLabelText(strings.settings.agentLabel)).toBeNull()
})

test('after a save the button itself says so, and an edit makes it a Save button again', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ projectId: 'p1', repoPath: '/repo', testCommand: 'npm test' }), { status: 200 }))
  stubFetch(fetchMock)
  try {
    const { findByRole } = render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={withRepo} />)
    fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
    fireEvent.click(screen.getByRole('button', { name: strings.settings.save }))
    const saved = await findByRole('button', { name: strings.settings.savedButton })
    expect(saved).toHaveAttribute('data-state', 'saved')
    expect(screen.getByRole('status')).toHaveTextContent(strings.settings.saved)
    fireEvent.change(screen.getByLabelText(strings.settings.testLabel), { target: { value: 'npm run test:unit' } })
    expect(screen.getByRole('button', { name: strings.settings.save })).toHaveAttribute('data-state', 'idle')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a refused save turns the button red and says why', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: strings.settings.notRepo }), { status: 400 })))
  try {
    const { findByRole } = render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={withRepo} />)
    fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
    fireEvent.click(screen.getByRole('button', { name: strings.settings.save }))
    expect(await findByRole('alert')).toHaveTextContent(strings.settings.notRepo)
    expect(screen.getByRole('button', { name: strings.settings.save })).toHaveAttribute('data-state', 'failed')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('choosing a folder fills the path and its test command, then saves them', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/system/choose-folder') return new Response(JSON.stringify({ path: '/Users/me/Desktop/comets-web', testCommand: 'pnpm test' }))
    const sent = JSON.parse(String(init?.body)) as { repoPath: string; testCommand: string }
    return new Response(JSON.stringify({ projectId: 'p1', ...sent }))
  })
  stubFetch(fetchMock)
  try {
    const { findByRole } = render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={withRepo} />)
    fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.settings.choose) }))
    expect(await findByRole('button', { name: strings.settings.savedButton })).toBeInTheDocument()
    expect(screen.getByLabelText(strings.settings.repoLabel)).toHaveValue('/Users/me/Desktop/comets-web')
    expect(screen.getByLabelText(strings.settings.testLabel)).toHaveValue('pnpm test')
    const put = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/projects/'))!
    expect(JSON.parse(String(put[1]!.body))).toEqual({ repoPath: '/Users/me/Desktop/comets-web', testCommand: 'pnpm test' })
  } finally {
    vi.unstubAllGlobals()
  }
})

test('closing the folder window changes nothing', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cancelled: true })))
  stubFetch(fetchMock)
  try {
    render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={withRepo} />)
    fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.settings.choose) }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: new RegExp(strings.settings.choose) })).toBeEnabled())
    expect(screen.getByLabelText(strings.settings.repoLabel)).toHaveValue('/repo')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the low-risk switch starts off and saves the moment it is turned on', async () => {
  const fetchMock = vi.fn(async (_u: string, init?: RequestInit) =>
    new Response(JSON.stringify({ ...withRepo, ...(JSON.parse(String(init?.body)) as object) })))
  stubFetch(fetchMock)
  try {
    render(<CanvasScreen workflowId="w1" graph={defaultGraph()} settings={withRepo} />)
    fireEvent.change(screen.getByLabelText(strings.settings.agentLabel), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: strings.projectSettings.open }))
    const box = screen.getByRole('checkbox', { name: new RegExp(strings.settings.autoLowLabel) })
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ autoApproveLowRisk: true })
    expect(box).toBeChecked()
  } finally {
    vi.unstubAllGlobals()
  }
})

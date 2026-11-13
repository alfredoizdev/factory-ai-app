// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { AgentSettings } from '@/ui/canvas/AgentSettings'
import { CommandCard } from '@/ui/canvas/CommandCard'
import type { ComposerImage } from '@/ui/canvas/Composer'
import { ProjectMemory } from '@/ui/canvas/ProjectMemory'
import type { ProjectSettings } from '@/engine/project-settings'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const a = strings.settings.ask
const base: ProjectSettings = { projectId: 'p1', repoPath: '/repo', testCommand: 'npm test', askMode: 'what_matters', currentBranch: null, defaultBranch: null }

/** A 390 px wide phone: nothing inside may need to scroll sideways. */
function phone(node: React.ReactNode) {
  return render(<div data-testid="phone" style={{ width: 390 }}>{node}</div>)
}
const fits = () => {
  const root = screen.getByTestId('phone')
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth)
}

test('what matters: two options, the first checked, the old third one not on screen', () => {
  phone(<AgentSettings settings={base} onSaved={() => {}} />)
  const radios = screen.getAllByRole('radio')
  expect(radios).toHaveLength(2)
  expect(screen.getByRole('radio', { name: new RegExp(a.whatMatters) })).toBeChecked()
  expect(screen.getByRole('radio', { name: new RegExp(a.everything) })).not.toBeChecked()
  expect(screen.queryByText(a.smallChanges)).toBeNull()
  expect(screen.getByRole('group', { name: a.title })).toBeInTheDocument()
  fits()
})

test('small changes: three options, the third checked', () => {
  phone(<AgentSettings settings={{ ...base, askMode: 'small_changes' }} onSaved={() => {}} />)
  expect(screen.getAllByRole('radio')).toHaveLength(3)
  expect(screen.getByRole('radio', { name: new RegExp(a.smallChanges) })).toBeChecked()
  fits()
})

test('every help text is on screen under its option, and tied to it', () => {
  render(<AgentSettings settings={{ ...base, askMode: 'small_changes' }} onSaved={() => {}} />)
  for (const [label, help] of [[a.whatMatters, a.whatMattersHelp], [a.everything, a.everythingHelp], [a.smallChanges, a.smallChangesHelp]] as const) {
    expect(screen.getByText(help)).toBeVisible()
    const radio = screen.getByRole('radio', { name: new RegExp(label) })
    expect(radio).toHaveAccessibleDescription(help)
    expect(radio).toHaveAccessibleName(label)
  }
})

test('choosing "everything" saves it at once', async () => {
  const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => new Response(JSON.stringify({ ...base, ...(JSON.parse(String(init?.body)) as object) })))
  vi.stubGlobal('fetch', fetchMock)
  const onSaved = vi.fn()
  render(<AgentSettings settings={base} onSaved={onSaved} />)
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(a.everything) }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  const put = fetchMock.mock.calls[0]!
  expect(put[1]!.method).toBe('PUT')
  expect(JSON.parse(String(put[1]!.body))).toEqual({ askMode: 'everything' })
  expect(screen.getByRole('radio', { name: new RegExp(a.everything) })).toBeChecked()
})

test('when saving fails the previous choice comes back and the person is told', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
  render(<AgentSettings settings={base} onSaved={() => {}} />)
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(a.everything) }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.settings.saveFailed)
  expect(screen.getByRole('radio', { name: new RegExp(a.whatMatters) })).toBeChecked()
})

test('the third option disappears once another is picked and the settings are opened again', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => new Response(JSON.stringify({ ...base, ...(JSON.parse(String(init?.body)) as object) }))))
  const loaded = { ...base, askMode: 'small_changes' as const }
  const first = render(<AgentSettings settings={loaded} onSaved={() => {}} />)
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(a.whatMatters) }))
  await waitFor(() => expect(screen.getByRole('radio', { name: new RegExp(a.whatMatters) })).toBeChecked())
  first.unmount()
  render(<AgentSettings settings={{ ...loaded, askMode: 'what_matters' }} onSaved={() => {}} />)
  expect(screen.getAllByRole('radio')).toHaveLength(2)
})

test('the decisions group says plainly which decisions can stop a task', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notes: [], entries: [], candidates: [] }))))
  render(<ProjectMemory projectId="p1" />)
  expect(await screen.findByText(strings.memory.decisionsLimit)).toBeInTheDocument()
})

function Card() {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  const [stop, setStop] = useState(false)
  return <CommandCard mode="idle" runId={null} text={text} onText={setText} images={images} onImages={setImages} onRun={() => undefined} canRun={false} onFollowUp={() => undefined} onSent={() => undefined} stopForMe={stop} onStopForMe={setStop} />
}

test('the request box has a "Stop for me on this one" box, off by default, with its explanation one press away and no pop-up', () => {
  const confirm = vi.fn()
  const alert = vi.fn()
  vi.stubGlobal('confirm', confirm)
  vi.stubGlobal('alert', alert)
  phone(<Card />)
  const box = screen.getByRole('checkbox', { name: strings.composer.stopForMe })
  expect(box).not.toBeChecked()
  expect(screen.queryByText(strings.composer.stopForMeWhy)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: strings.composer.stopForMeWhat }))
  expect(screen.getByText(strings.composer.stopForMeWhy)).toBeVisible()
  fireEvent.click(box)
  expect(box).toBeChecked()
  expect(confirm).not.toHaveBeenCalled()
  expect(alert).not.toHaveBeenCalled()
  fits()
})

test('checking the box sends stopForMe with the request, and the box is clear again for the next task', async () => {
  const { defaultGraph } = await import('@/domain/graph')
  const { CanvasScreen } = await import('@/ui/canvas/CanvasScreen')
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('EventSource', class { onopen = null; onmessage = null; onerror = null; close() {} })
  const graph = defaultGraph()
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/publish')) return new Response('{}')
    if (url.endsWith('/runs') && init?.method === 'POST') return new Response(JSON.stringify({ runId: 'r9' }))
    if (url === '/api/runs/r9') return new Response(JSON.stringify({ runId: 'r9', providerId: 'claude', blocks: graph.blocks }))
    if (url.endsWith('/runs')) return new Response('{"runs":[]}')
    if (url === '/api/projects') return new Response('{"projects":[]}')
    if (url.endsWith('/notes')) return new Response('{"notes":[]}')
    return new Response('{}', { status: 404 })
  }))
  render(<CanvasScreen workflowId="w1" graph={graph} settings={base} />)
  fireEvent.change(screen.getByLabelText(strings.run.requestLabel), { target: { value: 'make it blue' } })
  fireEvent.click(screen.getByRole('checkbox', { name: strings.composer.stopForMe }))
  fireEvent.click(screen.getByRole('button', { name: strings.run.send }))
  await waitFor(() => expect(calls.some(c => c.url === '/api/runs/r9')).toBe(true))
  const post = calls.find(c => c.url.endsWith('/runs') && c.init?.method === 'POST')!
  expect(JSON.parse(String(post.init!.body)).stopForMe).toBe(true)
  await waitFor(() => expect(screen.getByRole('checkbox', { name: strings.composer.stopForMe })).not.toBeChecked())
})

test('the choices cannot be changed while a save is on its way', async () => {
  let release: (r: Response) => void = () => undefined
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(res => { release = res })))
  render(<AgentSettings settings={base} onSaved={() => {}} />)
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(a.everything) }))
  for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
  release(new Response(JSON.stringify({ ...base, askMode: 'everything' })))
  await waitFor(() => expect(screen.getByRole('radio', { name: new RegExp(a.whatMatters) })).toBeEnabled())
})

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { AddProjectDialog } from '@/ui/canvas/AddProjectDialog'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const analysis = {
  root: '/Users/me/shop',
  name: 'shop',
  packageManager: 'pnpm',
  framework: 'Next.js',
  commands: { test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build', typecheck: null },
  defaultBranch: 'main',
  github: { repo: 'me/shop', gh: 'ready' },
  deploy: ['Vercel'],
}

test('reads the folder, shows what it found, and creates the project with the checks left ticked', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/analyze') return new Response(JSON.stringify(analysis))
    if (url === '/api/projects' && init?.method === 'POST') return new Response(JSON.stringify({ projectId: 'p', workflowId: 'w9' }), { status: 201 })
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetchMock)
  const onCreated = vi.fn()
  render(<AddProjectDialog onClose={() => {}} onCreated={onCreated} />)
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/Users/me/shop' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  const found = await screen.findByTestId('setup-found')
  expect(found).toHaveTextContent('pnpm')
  expect(found).toHaveTextContent('Next.js')
  expect(found).toHaveTextContent('me/shop')
  expect(found).toHaveTextContent('Vercel')
  // Found things carry a tick; nothing here is required and missing, so creating is allowed.
  expect(found.querySelectorAll('[data-level="required"]').length).toBe(1) // only the legend's sample
  expect(screen.getByTestId('check-folder')).toHaveAttribute('data-checked', 'true')
  expect(screen.getByTestId('check-folder')).toHaveTextContent(strings.setup.checked)
  expect(screen.getByLabelText(strings.setup.testCommand)).toHaveValue('pnpm test')
  // Lint and Build are suggested; untick Build.
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(strings.setup.checkLabel.build) }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.create) }))
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('w9'))
  const sent = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === '/api/projects' && i?.method === 'POST')![1]!.body))
  expect(sent).toEqual({ path: '/Users/me/shop', name: 'shop', testCommand: 'pnpm test', checks: [{ label: 'Lint', command: 'pnpm lint' }], askMode: 'what_matters' })
})

test('a folder that is not a repository says why', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: strings.settings.notRepo }), { status: 400 })))
  render(<AddProjectDialog onClose={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/tmp' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.settings.notRepo)
})

test('what is missing is told apart: optional things in yellow never block, a missing main branch in red does', async () => {
  const bare = { root: '/Users/me/bare', name: 'bare', packageManager: null, framework: null, commands: {}, defaultBranch: null, github: { repo: null, gh: 'no-remote' }, deploy: [] }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(bare))))
  render(<AddProjectDialog onClose={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/Users/me/bare' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  const found = await screen.findByTestId('setup-found')
  const level = (label: string) => [...found.querySelectorAll('div[data-level]')].find(r => r.textContent?.includes(label))?.getAttribute('data-level')
  expect(level(strings.setup.gitRepo)).toBe('ok')
  expect(level(strings.setup.github)).toBe('optional')
  expect(level(strings.setup.tests)).toBe('optional')
  expect(level(strings.setup.mainBranch)).toBe('required')
  expect(screen.getByTestId('fix-required')).toHaveTextContent(strings.setup.fixRequired)
  expect(screen.getByRole('button', { name: new RegExp(strings.setup.create) })).toBeDisabled()
  // Changing the folder by hand: the button asks to check it again.
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/Users/me/other' } })
  expect(screen.getByTestId('check-folder')).toHaveAttribute('data-checked', 'false')
})

test('the dialog offers the same two plain choices, starts on "what matters", and sends the one picked', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/analyze') return new Response(JSON.stringify(analysis))
    if (url === '/api/projects' && init?.method === 'POST') return new Response(JSON.stringify({ projectId: 'p', workflowId: 'w9' }), { status: 201 })
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<AddProjectDialog onClose={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/Users/me/shop' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  await screen.findByTestId('setup-found')
  const a = strings.settings.ask
  expect(screen.getAllByRole('radio')).toHaveLength(2)
  expect(screen.getByRole('radio', { name: new RegExp(a.whatMatters) })).toBeChecked()
  expect(screen.queryByText(a.smallChanges)).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(a.everything) }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.create) }))
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/projects' && i?.method === 'POST')).toBe(true))
  const sent = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === '/api/projects' && i?.method === 'POST')![1]!.body))
  expect(sent.askMode).toBe('everything')
})

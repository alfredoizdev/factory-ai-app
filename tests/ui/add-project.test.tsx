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
  expect(screen.getByLabelText(strings.setup.testCommand)).toHaveValue('pnpm test')
  // Lint and Build are suggested; untick Build.
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(strings.setup.checkLabel.build) }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.create) }))
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('w9'))
  const sent = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === '/api/projects' && i?.method === 'POST')![1]!.body))
  expect(sent).toEqual({ path: '/Users/me/shop', name: 'shop', testCommand: 'pnpm test', checks: [{ label: 'Lint', command: 'pnpm lint' }], autoApproveLowRisk: false })
})

test('a folder that is not a repository says why', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: strings.settings.notRepo }), { status: 400 })))
  render(<AddProjectDialog onClose={() => {}} onCreated={() => {}} />)
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/tmp' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.settings.notRepo)
})

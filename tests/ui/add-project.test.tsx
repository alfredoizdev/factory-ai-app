// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { AddProjectDialog } from '@/ui/canvas/AddProjectDialog'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const w = strings.wizard
const next = () => fireEvent.click(screen.getByRole('button', { name: w.next }))
/** Opens the wizard on the way in for a folder that already has code. */
function openExisting(onCreated: (id: string) => void = () => {}) {
  render(<AddProjectDialog onClose={() => {}} onCreated={onCreated} />)
  fireEvent.click(screen.getByTestId('way-existing'))
  next()
}

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
  openExisting(onCreated)
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
  next()
  next()
  expect(screen.getByTestId('wizard-summary')).toHaveTextContent('me/shop')
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.create) }))
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('w9'))
  const sent = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === '/api/projects' && i?.method === 'POST')![1]!.body))
  expect(sent).toEqual({ path: '/Users/me/shop', name: 'shop', testCommand: 'pnpm test', checks: [{ label: 'Lint', command: 'pnpm lint' }], askMode: 'what_matters' })
})

test('a folder that is not a repository says why', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: strings.settings.notRepo }), { status: 400 })))
  openExisting()
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/tmp' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.settings.notRepo)
})

test('what is missing is told apart: optional things in yellow never block, a missing main branch in red does', async () => {
  const bare = { root: '/Users/me/bare', name: 'bare', packageManager: null, framework: null, commands: {}, defaultBranch: null, github: { repo: null, gh: 'no-remote' }, deploy: [] }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(bare))))
  openExisting()
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/Users/me/bare' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  const found = await screen.findByTestId('setup-found')
  const level = (label: string) => [...found.querySelectorAll('div[data-level]')].find(r => r.textContent?.includes(label))?.getAttribute('data-level')
  expect(level(strings.setup.gitRepo)).toBe('ok')
  expect(level(strings.setup.github)).toBe('optional')
  expect(level(strings.setup.tests)).toBe('optional')
  expect(level(strings.setup.mainBranch)).toBe('required')
  expect(screen.getByTestId('fix-required')).toHaveTextContent(strings.setup.fixRequired)
  expect(screen.getByRole('button', { name: w.next })).toBeDisabled()
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
  openExisting()
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/Users/me/shop' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  await screen.findByTestId('setup-found')
  next()
  next()
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

const scratchFetch = () =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/system/choose-folder') return new Response(JSON.stringify({ path: '/Users/me/Desktop' }))
    if (url === '/api/projects/scratch' && init?.method === 'POST') return new Response(JSON.stringify({ projectId: 'p', workflowId: 'w1', firstTask: 'Create the project' }), { status: 201 })
    return new Response('{}')
  })
const sentTo = (fetchMock: ReturnType<typeof scratchFetch>, url: string) => JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === url && i?.method === 'POST')![1]!.body))

test('from scratch: five named steps, logos to pick from, a folder named after the project, and everything chosen is sent', async () => {
  const fetchMock = scratchFetch()
  vi.stubGlobal('fetch', fetchMock)
  const onCreated = vi.fn()
  render(<AddProjectDialog onClose={() => {}} onCreated={onCreated} />)
  // From scratch is the way in already marked.
  expect(screen.getByTestId('way-scratch')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('wizard-steps').querySelectorAll('li')).toHaveLength(5)
  next()
  // Every technology is a button with its logo; one front end at a time, any number of back-end pieces.
  const nextjs = screen.getByRole('button', { name: 'Next.js' })
  expect(nextjs.querySelector('svg path')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'React' }))
  fireEvent.click(nextjs)
  expect(screen.getByRole('button', { name: 'React' })).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(screen.getByRole('button', { name: 'Prisma' }))
  fireEvent.click(screen.getByRole('button', { name: 'Postgres' }))
  next()
  // Nothing to go on with until there is a name and a full path.
  expect(screen.getByRole('button', { name: w.next })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(w.where.name), { target: { value: 'My Landing Page' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(w.where.chooseParent) }))
  await vi.waitFor(() => expect(screen.getByLabelText(w.where.folder)).toHaveValue('/Users/me/Desktop/my-landing-page'))
  // The folder follows the name while it is still the one the app wrote.
  fireEvent.change(screen.getByLabelText(w.where.name), { target: { value: 'Shop' } })
  expect(screen.getByLabelText(w.where.folder)).toHaveValue('/Users/me/Desktop/shop')
  expect(screen.getByRole('switch', { name: new RegExp(w.where.addTests) })).toBeChecked()
  fireEvent.change(screen.getByLabelText(new RegExp('GitHub')), { target: { value: 'https://github.com/me/shop' } })
  next()
  // Balanced is the preset already marked; Best quality fills every step, and one step can then be changed by hand.
  expect(screen.getByTestId('preset-balanced')).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByTestId('preset-best'))
  expect(screen.getByLabelText(w.models.modelFor('Build'))).toHaveValue('opus')
  fireEvent.change(screen.getByLabelText(w.models.modelFor('Plan')), { target: { value: 'sonnet' } })
  expect(screen.getByTestId('preset-best')).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByText(w.models.testsNote)).toBeInTheDocument()
  next()
  const summary = screen.getByTestId('wizard-summary')
  expect(summary).toHaveTextContent('Next.js, Prisma and PostgreSQL')
  expect(summary).toHaveTextContent('/Users/me/Desktop/shop')
  expect(summary).toHaveTextContent('Plan Sonnet · Build Opus · Review Opus')
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.create) }))
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('w1'))
  expect(sentTo(fetchMock, '/api/projects/scratch')).toEqual({
    path: '/Users/me/Desktop/shop',
    name: 'Shop',
    githubUrl: 'https://github.com/me/shop',
    stack: { frontEnd: 'nextjs', backEnds: ['prisma', 'postgres'] },
    addTests: true,
    askMode: 'what_matters',
    models: { plan: 'sonnet', build: 'opus', review: 'opus' },
  })
  // The first task waits for the canvas to put it in the task box.
  expect(window.sessionStorage.getItem('factory.firstTask.w1')).toBe('Create the project')
})

test('going back keeps what was chosen, and a refusal from the app is said on the last screen', async () => {
  const fetchMock = vi.fn(async (url: string) => (url === '/api/projects/scratch' ? new Response(JSON.stringify({ error: w.errors.notEmpty }), { status: 400 }) : new Response('{}')))
  vi.stubGlobal('fetch', fetchMock)
  const onCreated = vi.fn()
  render(<AddProjectDialog onClose={() => {}} onCreated={onCreated} />)
  next()
  fireEvent.click(screen.getByRole('button', { name: 'Vue' }))
  next()
  fireEvent.click(screen.getByRole('button', { name: w.back }))
  expect(screen.getByRole('button', { name: 'Vue' })).toHaveAttribute('aria-pressed', 'true')
  next()
  fireEvent.change(screen.getByLabelText(w.where.name), { target: { value: 'Old' } })
  fireEvent.change(screen.getByLabelText(w.where.folder), { target: { value: '/Users/me/old' } })
  fireEvent.click(screen.getByRole('switch', { name: new RegExp(w.where.addTests) }))
  next()
  next()
  expect(screen.getByTestId('wizard-summary')).toHaveTextContent(w.review.notConnected)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.create) }))
  expect(await screen.findByRole('alert')).toHaveTextContent(w.errors.notEmpty)
  expect(onCreated).not.toHaveBeenCalled()
  const call = fetchMock.mock.calls.find(([u]) => u === '/api/projects/scratch') as unknown as [string, RequestInit]
  const sent = JSON.parse(String(call[1].body))
  expect(sent.addTests).toBe(false)
  expect(sent.githubUrl).toBeNull()
  // Balanced leaves every step on its default, so nothing about models is sent.
  expect(sent.models).toBeUndefined()
})

test('a folder that already has code: its own folders are offered to ask about, and the ticked ones are sent', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/analyze') return new Response(JSON.stringify({ ...analysis, folders: ['docs/', 'src/checkout/'] }))
    if (url === '/api/projects' && init?.method === 'POST') return new Response(JSON.stringify({ projectId: 'p', workflowId: 'w9' }), { status: 201 })
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetchMock)
  openExisting()
  expect(screen.getByTestId('wizard-steps').querySelectorAll('li')).toHaveLength(4)
  fireEvent.change(screen.getByLabelText(strings.setup.folder), { target: { value: '/Users/me/shop' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.read) }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'src/checkout/' }))
  next()
  fireEvent.click(screen.getByTestId('preset-fast'))
  next()
  expect(screen.getByTestId('wizard-summary')).toHaveTextContent('src/checkout/')
  fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.setup.create) }))
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/projects' && i?.method === 'POST')).toBe(true))
  const sent = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === '/api/projects' && i?.method === 'POST')![1]!.body))
  expect(sent.coreAreas).toEqual(['src/checkout/'])
  expect(sent.models).toEqual({ plan: 'haiku', build: 'sonnet', review: 'sonnet' })
})

test('from scratch: an empty folder the person chose is the project\'s own folder, with nothing added inside it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/system/choose-folder' ? { path: '/Users/me/Desktop/landing', empty: true } : {}))),
  )
  render(<AddProjectDialog startWith="scratch" onClose={() => {}} onCreated={() => {}} />)
  next()
  fireEvent.change(screen.getByLabelText(w.where.name), { target: { value: 'My Landing Page' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(w.where.chooseParent) }))
  await vi.waitFor(() => expect(screen.getByLabelText(w.where.folder)).toHaveValue('/Users/me/Desktop/landing'))
  // It stays the folder chosen when the name changes.
  fireEvent.change(screen.getByLabelText(w.where.name), { target: { value: 'Shop' } })
  expect(screen.getByLabelText(w.where.folder)).toHaveValue('/Users/me/Desktop/landing')
})

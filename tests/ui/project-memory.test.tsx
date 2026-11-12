// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ProjectMemory } from '@/ui/canvas/ProjectMemory'
import type { Entry } from '@/engine/register'
import { strings } from '@/ui/strings'

const entry = (over: Partial<Entry>): Entry => ({ id: 'e', number: 1, kind: 'rule', text: '', paths: [], source: 'person', runId: null, enabled: true, outcome: null, reason: null, createdAt: '2026-11-12T10:00:00.000Z', ...over })
let entries: Entry[]
let candidates: { area: string; paths: string[] }[]
let calls: { url: string; method: string; body: unknown }[]
let respond: (url: string, method: string, body: Record<string, unknown>) => Response | null

beforeEach(() => {
  entries = [
    entry({ id: 'r1', number: 1, kind: 'rule', text: 'Buttons are always blue' }),
    entry({ id: 'd1', number: 2, kind: 'decision', text: 'Use Stripe for payments — Yes', source: 'question' }),
    entry({ id: 'c1', number: 3, kind: 'core', text: 'Ask me before changing src/billing/', paths: ['src/billing/'] }),
    entry({ id: 'f1', number: 4, kind: 'finding', text: 'The token is logged', paths: ['src/log.ts'], source: 'review', outcome: 'done' }),
  ]
  candidates = [{ area: 'sign-in and sessions', paths: ['src/lib/auth.ts'] }]
  calls = []
  respond = () => null
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, method, body })
    const custom = respond(url, method, body)
    if (custom) return custom
    if (method === 'GET') return new Response(JSON.stringify({ notes: [], entries, candidates }))
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (method === 'PATCH') return new Response(JSON.stringify({ note: { ...entries.find(e => url.endsWith(e.id))!, ...body } }))
    return new Response(JSON.stringify({ note: entry({ id: 'new', number: 9, kind: 'core', text: 'Ask me before changing src/app/', paths: ['src/app/'] }) }), { status: 201 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const open = async () => {
  render(<ProjectMemory projectId="p1" />)
  await screen.findByText('Buttons are always blue')
}

test('entries are grouped by kind under plain headings, each with its number and words', async () => {
  await open()
  for (const h of [strings.memory.groups.rule, strings.memory.groups.decision, strings.memory.groups.core]) expect(screen.getByRole('heading', { name: h })).toBeInTheDocument()
  expect(screen.getByText('Use Stripe for payments — Yes')).toBeInTheDocument()
  expect(screen.getByText('D-02')).toBeInTheDocument()
  expect(screen.getByText('D-03')).toBeInTheDocument()
  expect(screen.getByText('src/billing/')).toBeInTheDocument()
})

test('the log of what reviewers found is collapsed until asked for, and never shows a file', async () => {
  await open()
  expect(screen.queryByText('The token is logged')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: strings.memory.showLog(1) }))
  expect(screen.getByText('The token is logged')).toBeInTheDocument()
  expect(screen.getByText(strings.memory.logAi)).toBeInTheDocument()
  expect(document.body.textContent).not.toContain('src/log.ts')
  expect(within(screen.getByTestId('project-memory')).queryAllByRole('button', { name: strings.memory.edit }).length).toBeGreaterThan(0) // rules still editable
  expect(screen.queryByRole('button', { name: strings.memory.remove('The token is logged') })).toBeNull() // a log line is not
})

test('a core area is added from a plain field with a one-line explanation, sent to the server as typed', async () => {
  await open()
  expect(screen.getByText(strings.memory.coreHint)).toBeInTheDocument()
  const field = screen.getByLabelText(strings.memory.coreLabel)
  expect(screen.getByRole('button', { name: strings.memory.coreAdd })).toBeDisabled()
  fireEvent.change(field, { target: { value: './src/app' } })
  fireEvent.click(screen.getByRole('button', { name: strings.memory.coreAdd }))
  await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ kind: 'core', path: './src/app' }))
  expect(await screen.findByText('src/app/')).toBeInTheDocument()
  expect((field as HTMLInputElement).value).toBe('')
})

test('a refused path shows the plain sentence the server sent', async () => {
  respond = (_u, m) => (m === 'POST' ? new Response(JSON.stringify({ error: strings.memory.core.outside }), { status: 400 }) : null)
  await open()
  fireEvent.change(screen.getByLabelText(strings.memory.coreLabel), { target: { value: '../x' } })
  fireEvent.click(screen.getByRole('button', { name: strings.memory.coreAdd }))
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.memory.core.outside)
})

test('suggestions become core only when the person confirms each one', async () => {
  await open()
  expect(screen.getByText(strings.memory.suggestionsTitle)).toBeInTheDocument()
  expect(screen.getByText(strings.memory.suggestionWhy('sign-in and sessions'))).toBeInTheDocument()
  expect(calls.some(c => c.method === 'POST')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: strings.memory.suggestionYes }))
  await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ kind: 'core', paths: ['src/lib/auth.ts'], area: 'sign-in and sessions' }))
  await waitFor(() => expect(screen.queryByText(strings.memory.suggestionWhy('sign-in and sessions'))).toBeNull())
})

test('a decision can be reworded', async () => {
  await open()
  const row = screen.getByText('Use Stripe for payments — Yes').closest('li')!
  fireEvent.click(within(row).getByRole('button', { name: strings.memory.edit }))
  const box = within(row).getByRole('textbox')
  fireEvent.change(box, { target: { value: 'Use Stripe only' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ url: '/api/projects/p1/notes/d1', body: { text: 'Use Stripe only' } }))
  expect(await screen.findByText('Use Stripe only')).toBeInTheDocument()
})

test('a core area\'s folder can be changed', async () => {
  await open()
  const row = screen.getByText('src/billing/').closest('li')!
  fireEvent.click(within(row).getByRole('button', { name: strings.memory.edit }))
  const box = within(row).getByRole('textbox')
  expect(box).toHaveValue('src/billing/')
  fireEvent.change(box, { target: { value: 'src/payments' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ path: 'src/payments' }))
})

test('removing asks first, in the panel, and nothing is removed until it is confirmed', async () => {
  const confirmSpy = vi.fn(() => true)
  vi.stubGlobal('confirm', confirmSpy)
  await open()
  const row = screen.getByText('Use Stripe for payments — Yes').closest('li')!
  fireEvent.click(within(row).getByRole('button', { name: strings.memory.remove('Use Stripe for payments — Yes') }))
  expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  fireEvent.click(within(row).getByRole('button', { name: strings.memory.removeNo }))
  expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  fireEvent.click(within(row).getByRole('button', { name: strings.memory.remove('Use Stripe for payments — Yes') }))
  fireEvent.click(within(row).getByRole('button', { name: strings.memory.removeYes }))
  await waitFor(() => expect(calls.find(c => c.method === 'DELETE')?.url).toBe('/api/projects/p1/notes/d1'))
  await waitFor(() => expect(screen.queryByText('Use Stripe for payments — Yes')).toBeNull())
  expect(confirmSpy).not.toHaveBeenCalled()
})

test('rules still work as before: added from the box, with Enter', async () => {
  await open()
  const box = screen.getByLabelText(strings.memory.addLabel)
  fireEvent.change(box, { target: { value: 'Write in Spanish' } })
  fireEvent.click(screen.getByRole('button', { name: strings.memory.add }))
  await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ text: 'Write in Spanish' }))
})

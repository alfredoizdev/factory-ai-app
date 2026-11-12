// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { BlockCard } from '@/ui/canvas/BlockCard'
import { CommandCard } from '@/ui/canvas/CommandCard'
import type { ComposerImage } from '@/ui/canvas/Composer'
import { errorExcerpt, fixOptions, type FailureActions } from '@/ui/canvas/FailurePanel'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const failure = {
  status: 'failed',
  canContinue: true,
  failed: [{ blockId: 'check-build', label: 'Build', kind: 'tests', cause: 'tests_failed', message: 'Failed. No test counts were recorded.', command: 'npm run build', exitCode: 1, signal: null, output: 'Type error: missing prop "title"\n  at src/app/page.tsx:12' }],
}

function Card({ actions, onFollowUp = () => {} }: { actions: { current: FailureActions | null }; onFollowUp?: (id: string) => void }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  return <CommandCard mode="failed" runId="r1" text={text} onText={setText} images={images} onImages={setImages} onRun={() => {}} canRun={false} onFollowUp={onFollowUp} onSent={() => setText('')} failureActions={actions} />
}

test('a failed task says which block stopped it; the window shows the command and what it printed; an option fills the box', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/failure')) return new Response(JSON.stringify(failure))
    if (url.endsWith('/follow-up') && init?.method === 'POST') return new Response(JSON.stringify({ runId: 'r2' }), { status: 201 })
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetchMock)
  const actions: { current: FailureActions | null } = { current: null }
  const onFollowUp = vi.fn()
  render(<Card actions={actions} onFollowUp={onFollowUp} />)
  expect(await screen.findByTestId('failure-summary')).toHaveTextContent(strings.failure.cardText('Build'))

  // The failed block's "See what went wrong" opens the window.
  await waitFor(() => expect(actions.current).not.toBeNull())
  actions.current!.see()
  const dialog = await screen.findByTestId('failure-dialog')
  expect(dialog).toHaveTextContent('npm run build')
  expect(dialog).toHaveTextContent(strings.failure.ended(1, null))
  expect(screen.getByTestId('failure-output')).toHaveTextContent('Type error: missing prop "title"')

  // Picking an option writes the request, with the error, into the box; nothing is sent yet.
  fireEvent.click(screen.getByRole('button', { name: strings.failure.options.fix.label }))
  expect(screen.queryByTestId('failure-dialog')).toBeNull()
  const box = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(box.value).toContain('npm run build')
  expect(box.value).toContain('Type error: missing prop "title"')
  expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/follow-up'))).toBe(false)

  // Sending it picks the work up in a new run.
  fireEvent.click(screen.getByRole('button', { name: strings.failure.send }))
  await waitFor(() => expect(onFollowUp).toHaveBeenCalledWith('r2'))
  const sent = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/follow-up') && i?.method === 'POST')![1]!.body)) as { note: string }
  expect(sent.note).toContain('Type error')
})

test('Try again on the failed block picks the work up without writing anything', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/failure')) return new Response(JSON.stringify(failure))
    if (url.endsWith('/follow-up') && init?.method === 'POST') return new Response(JSON.stringify({ runId: 'r3' }), { status: 201 })
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetchMock)
  const actions: { current: FailureActions | null } = { current: null }
  const onFollowUp = vi.fn()
  render(<Card actions={actions} onFollowUp={onFollowUp} />)
  await screen.findByTestId('failure-summary')
  await waitFor(() => expect(actions.current).not.toBeNull())
  actions.current!.again()
  await waitFor(() => expect(onFollowUp).toHaveBeenCalledWith('r3'))
})

test('a failed task whose work cannot be picked up says so and offers no box', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...failure, canContinue: false }))))
  render(<Card actions={{ current: null }} />)
  expect(await screen.findByText(strings.failure.cannotContinue)).toBeInTheDocument()
  expect(screen.queryByRole('textbox')).toBeNull()
})

test('a failed block carries its own buttons; a passed one does not', () => {
  const block = { id: 'b', kind: 'tests' as const, label: 'Build', enabled: true, config: {}, position: { x: 0, y: 0 } }
  const onSee = vi.fn()
  const onAgain = vi.fn()
  const { rerender } = render(<BlockCard block={block} view={{ blockId: 'b', state: 'failed', steps: [], summary: '' } as never} failedActions={{ onSee, onAgain }} />)
  fireEvent.click(screen.getByRole('button', { name: strings.failure.see }))
  fireEvent.click(screen.getByRole('button', { name: strings.failure.tryAgain }))
  expect(onSee).toHaveBeenCalledTimes(1)
  expect(onAgain).toHaveBeenCalledTimes(1)
  rerender(<BlockCard block={block} view={{ blockId: 'b', state: 'passed', steps: [], summary: '' } as never} failedActions={{ onSee, onAgain }} />)
  expect(screen.queryByTestId('failed-actions')).toBeNull()
})

test('the error handed to the agents is the end of the output, kept short', () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  expect(errorExcerpt(long).split('\n')).toHaveLength(25)
  expect(errorExcerpt(long)).toContain('line 99')
  expect(errorExcerpt(null)).toBe('')
  expect(fixOptions(undefined).map(o => o.key)).toEqual(['fix', 'simpler', 'explain', 'again'])
})

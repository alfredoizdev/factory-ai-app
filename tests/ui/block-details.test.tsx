// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { BlockCard } from '@/ui/canvas/BlockCard'
import { BlockDetailsDialog, howLong } from '@/ui/canvas/BlockDetails'
import { strings } from '@/ui/strings'

afterEach(() => vi.unstubAllGlobals())

const details = {
  blockId: 'build', label: 'Build', kind: 'build', state: 'passed', attempt: 1,
  startedAt: '2026-11-11T10:00:00.000Z', finishedAt: '2026-11-11T10:02:05.000Z', durationMs: 125_000,
  model: 'opus', tokens: 115257, summary: 'I replaced the home page.', steps: ['Read page.tsx', 'Edited page.tsx'],
  jobs: [{ title: 'Build the landing page', done: ['It has a hero'] }],
  commands: [{ command: 'npm run build', exitCode: 0, signal: null, durationMs: 2500, output: 'Compiled' }],
}

test('the details window shows what the block did, how long it took and the tokens it used', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(details))))
  render(<BlockDetailsDialog runId="r1" blockId="build" label="Build" onClose={() => {}} />)
  const dialog = await screen.findByTestId('block-details')
  expect(await screen.findByTestId('details-summary')).toHaveTextContent('I replaced the home page.')
  expect(dialog).toHaveTextContent('2m 5s')
  expect(dialog).toHaveTextContent('115,257')
  expect(dialog).toHaveTextContent('opus')
  expect(screen.getByTestId('details-steps')).toHaveTextContent('Edited page.tsx')
  expect(dialog).toHaveTextContent('Build the landing page')
  expect(dialog).toHaveTextContent('npm run build')
})

test('a block that ran offers its details; one still waiting its turn does not', () => {
  const block = { id: 'b', kind: 'build' as const, label: 'Build', enabled: true, config: {}, position: { x: 0, y: 0 } }
  const onDetails = vi.fn()
  const { rerender } = render(<BlockCard block={block} view={{ state: 'passed', summary: '', summaryIsClaim: false }} onDetails={onDetails} />)
  fireEvent.click(screen.getByRole('button', { name: strings.details.see }))
  expect(onDetails).toHaveBeenCalledTimes(1)
  rerender(<BlockCard block={block} view={{ state: 'queued', summary: '', summaryIsClaim: false }} onDetails={onDetails} />)
  expect(screen.queryByRole('button', { name: strings.details.see })).toBeNull()
})

test('a length of work is said the way a person would', () => {
  expect(howLong(400)).toBe(strings.details.underASecond)
  expect(howLong(41_000)).toBe('41s')
  expect(howLong(3_725_000)).toBe('1h 2m')
})

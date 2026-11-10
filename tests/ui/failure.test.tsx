// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import type { Block, BlockKind } from '@/domain/graph'
import { describeEvent } from '@/ui/EventBar'
import { BlockCard } from '@/ui/canvas/BlockCard'
import { emptyStream, foldEvent, toViews, type StreamState, type Wire } from '@/ui/canvas/useRunStream'
import { strings } from '@/ui/strings'

// A failed card must say what the system recorded, not the per-kind template that guesses at a cause.

const KINDS: BlockKind[] = ['input', 'plan', 'build', 'tests', 'review', 'approve', 'human', 'ship']
const block = (kind: BlockKind): Block => ({ id: kind, kind, label: strings.blocks[kind], enabled: true, config: {}, position: { x: 0, y: 0 } })

let seq = 0
const wire = (type: string, payload: Record<string, unknown>): Wire => ({ sequence: ++seq, type: type as Wire['type'], payload })

function failed(kind: BlockKind, payload: Record<string, unknown>) {
  seq = 0
  const events = [wire('node.queued', { blockId: kind }), wire('node.started', { blockId: kind }), wire('node.failed', { blockId: kind, ...payload })]
  const stream: StreamState = events.reduce(foldEvent, emptyStream)
  return { view: toViews(stream.nodes, [block(kind)])[kind]!, line: describeEvent(events[2]!, block(kind)) }
}

// What the executor writes for each recorded cause.
const TIMEOUT = { cause: 'timeout', message: strings.run.timedOut(600), messageSource: 'system' }
const CRASHED = { cause: 'provider_crashed', message: strings.run.providerCrashed, messageSource: 'system' }
const NO_RESULT = { cause: 'no_result', message: strings.run.noResult, messageSource: 'system' }
const PROVIDER = { cause: 'provider_error', message: 'The model refused the request.', messageSource: 'provider' }

const failedTemplates = KINDS.map(k => (strings.summary as unknown as Record<string, { failed?: string }>)[k]?.failed).filter((t): t is string => !!t)

describe.each(KINDS.filter(k => k !== 'human'))('a %s block that failed', kind => {
  test.each([['timeout', TIMEOUT], ['provider_crashed', CRASHED], ['no_result', NO_RESULT]] as const)('names the recorded cause: %s', (_name, payload) => {
    const { view, line } = failed(kind, payload)
    expect(view.summary).toBe(payload.message)
    expect(line.text).toBe(payload.message)
    // The system wrote it, so it is not shown as an AI claim.
    expect(view.summaryIsClaim).toBe(false)
    expect(line.isClaim).toBe(false)
    for (const t of failedTemplates) expect(view.summary).not.toBe(t)
  })

  test('shows a provider error as the provider\'s words, marked as a claim', () => {
    const { view, line } = failed(kind, PROVIDER)
    expect(view.summary).toBe(PROVIDER.message)
    expect(view.summaryIsClaim).toBe(true)
    expect(line).toEqual({ text: PROVIDER.message, isClaim: true })
  })

  test('renders the cause on the card, with the claim marker only for provider text', () => {
    const timeout = failed(kind, TIMEOUT).view
    const { unmount } = render(<BlockCard block={block(kind)} view={timeout} />)
    expect(screen.getByText(strings.run.timedOut(600))).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(strings.canvas.claimMarker))).toBeNull()
    unmount()
    render(<BlockCard block={block(kind)} view={failed(kind, PROVIDER).view} />)
    expect(screen.getByText(PROVIDER.message, { exact: false })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(strings.canvas.claimMarker))).toBeInTheDocument()
  })
})

test('a human block that crashed names its cause too', () => {
  const { view } = failed('human', { cause: 'internal_error', message: strings.run.internalFailure, messageSource: 'system' })
  expect(view.summary).toBe(strings.run.internalFailure)
})

test('a person turning a human block down keeps the per-kind wording, which is true', () => {
  const { view, line } = failed('human', { cause: 'rejected', message: strings.run.rejected, messageSource: 'system' })
  expect(view.summary).toBe(strings.summary.human.failed)
  expect(line.text).toBe(strings.summary.human.failed)
})

test('a recorded cause with no message still names the cause rather than a template', () => {
  const { view } = failed('review', { cause: 'timeout' })
  expect(view.summary).toBe(strings.summary.cause.timeout)
  expect(view.summary).not.toBe(strings.summary.review.failed)
})

test('an unrecognised message source is treated as a model\'s words', () => {
  expect(failed('plan', { ...PROVIDER, messageSource: 'something-new' }).view.summaryIsClaim).toBe(true)
  expect(failed('plan', { cause: 'provider_error', message: 'x' }).view.summaryIsClaim).toBe(true)
})

test('a failure event from before causes were recorded still gets the template', () => {
  expect(failed('review', {}).view.summary).toBe(strings.summary.review.failed)
})

test('the failed-template list the not-equal assertions rely on is not empty', () => {
  expect(failedTemplates.length).toBeGreaterThan(3)
})

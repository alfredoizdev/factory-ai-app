// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Block } from '@/domain/graph'
import { LiveSite } from '@/ui/canvas/LiveSite'
import { StepsLane } from '@/ui/canvas/StepsView'
import { strings } from '@/ui/strings'

const block = (id: string, kind: Block['kind'], label: string): Block => ({ id, kind, label, enabled: true, config: {}, position: { x: 0, y: 0 } })
const blocks = [block('input', 'input', 'Input'), block('build', 'build', 'Build'), block('ship', 'ship', 'Ship')]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('direct edit', () => {
  it('puts the steps in a column with the site beside them, and no details under the steps', () => {
    render(<StepsLane blocks={blocks} stateOf={() => 'passed'} hasRun pickedId="build" onPick={() => undefined} detail={<p>the details</p>} side={<p>the site</p>} />)
    expect(screen.getByTestId('direct-edit').textContent).toContain('the site')
    expect(screen.getByTestId('steps-view').getAttribute('data-column')).toBe('true')
    expect(screen.getByTestId('steps-row').style.flexDirection).toBe('column')
    expect(screen.queryByText('the details')).toBeNull()
  })

  it('says what will show before there is a task, and starts nothing', () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    render(<LiveSite runId={null} />)
    expect(screen.getByText(strings.direct.emptyTitle)).toBeTruthy()
    expect(fetched).not.toHaveBeenCalled()
  })

  it('starts the site of the open task by itself and shows it once it answers', async () => {
    const calls: string[] = []
    let started = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (init?.method === 'POST') started = true
      const state = started ? { status: 'ready', url: 'http://127.0.0.1:4200/', message: null, log: '' } : { status: 'stopped', url: null, message: null, log: '' }
      return { ok: true, json: async () => state }
    }))
    render(<LiveSite runId="r1" />)
    await waitFor(() => expect(screen.getByTestId('live-site-frame').getAttribute('src')).toBe('http://127.0.0.1:4200/'))
    expect(calls.filter(c => c.startsWith('POST'))).toEqual(['POST /api/runs/r1/preview'])
    expect(screen.getByText(strings.direct.reload)).toBeTruthy()
  })

  it('says so when the site did not start, with a way to start it again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'failed', url: null, message: strings.preview.exited, log: 'boom' }) })))
    render(<LiveSite runId="r1" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(strings.preview.exited))
    expect(screen.getByText(strings.direct.tryAgain)).toBeTruthy()
  })
})

import { fireEvent } from '@testing-library/react'
import type { Question } from '@/engine/questions'
import { DirectPause, MANY_REQUESTS } from '@/ui/canvas/QuestionPanel'

const pause = (n: number, text: string = strings.direct.pauseText): Question => ({
  id: 'q1', runId: 'r1', nodeRunId: 'n1', findingId: `direct-${n}`, kind: 'direct', text, why: strings.direct.pauseWhy, detail: 'Made the title blue.',
  options: [{ id: 'leave', label: strings.direct.doneLabel, means: strings.direct.doneMeans }], recommended: null, touches: [], state: 'open', answerOption: null, answerText: null, actor: null, answeredAt: null,
})

describe('direct edit between two requests', () => {
  it('shows what was built, sends the next request in the person\'s words, and "done" ends it', async () => {
    const sent: [string, string | undefined][] = []
    const view = render(<DirectPause question={pause(1)} onAnswer={async (o, t) => void sent.push([o, t])} />)
    expect(screen.getByText('Made the title blue.')).toBeTruthy()
    expect(screen.queryByTestId('direct-many')).toBeNull()
    fireEvent.change(screen.getByLabelText(strings.direct.nextLabel), { target: { value: ' make it bigger ' } })
    fireEvent.click(screen.getByText(strings.direct.send))
    await waitFor(() => expect(sent).toEqual([['other', 'make it bigger']]))
    view.unmount()
    render(<DirectPause question={pause(2)} onAnswer={async (o, t) => void sent.push([o, t])} />)
    fireEvent.click(screen.getByTestId('direct-done'))
    await waitFor(() => expect(sent[1]).toEqual(['leave', undefined]))
  })

  it('says the task is getting big after several requests, and only offers to finish on the last one', () => {
    const view = render(<DirectPause question={pause(MANY_REQUESTS)} onAnswer={async () => undefined} />)
    expect(screen.getByTestId('direct-many').textContent).toBe(strings.direct.many)
    view.unmount()
    render(<DirectPause question={pause(12, strings.direct.lastText)} onAnswer={async () => undefined} />)
    expect(screen.getByTestId('direct-many').textContent).toBe(strings.direct.lastText)
    expect(screen.queryByLabelText(strings.direct.nextLabel)).toBeNull()
    expect(screen.getByTestId('direct-done')).toBeTruthy()
  })
})

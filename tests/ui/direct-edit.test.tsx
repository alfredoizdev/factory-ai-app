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

import { expect, test, type Page } from '@playwright/test'

// Warms the run routes. A cold dev server compiles each route on first use, and that compile could delay the run.
// The workflow id is deliberately a nonexistent one: the calls answer 404 and only exist to compile the routes.
test.beforeAll(async ({ request }) => {
  await request.get('/api/inngest')
  await request.post('/api/workflows/warm-up/runs', { data: { request: 'warm-up' } })
  await request.get('/api/runs/warm-up')
  await request.get('/api/runs/warm-up/events', { timeout: 10_000 }).catch(() => undefined)
})

declare global {
  interface Window {
    __states: Record<string, string[]>
  }
}

// Records every state each block card passes through, so "Build was running" is something we observed rather than
// something we happened to be looking at. Installed before the page loads; MutationObserver sees every change.
async function recordStates(page: Page) {
  await page.addInitScript(() => {
    window.__states = {}
    const note = (el: Element) => {
      const id = el.getAttribute('data-testid')
      const state = el.getAttribute('data-state')
      if (!id?.startsWith('node-') || !state) return
      const seen = (window.__states[id] ??= [])
      if (seen[seen.length - 1] !== state) seen.push(state)
    }
    new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element) note(r.target)
        r.addedNodes.forEach(n => {
          if (n instanceof Element) {
            note(n)
            n.querySelectorAll('[data-testid^="node-"]').forEach(note)
          }
        })
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] })
  })
}

type Sample = { distance: number; progress: number; length: number }

// For each particle on the cable, how far it is from the real cable (screen px) and how far along it is (path length).
async function sampleParticles(page: Page, cable: string): Promise<Sample[]> {
  return page.evaluate(id => {
    const path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`)
    const circles = document.querySelectorAll<SVGCircleElement>(`[data-testid="particles-${id}"] circle`)
    if (!path) throw new Error(`no cable ${id}`)
    const toScreen = path.getScreenCTM()
    if (!toScreen) throw new Error('cable has no screen matrix')
    const length = path.getTotalLength()
    return [...circles].map(c => {
      const box = c.getBoundingClientRect()
      const px = box.x + box.width / 2
      const py = box.y + box.height / 2
      let best = Infinity
      let at = 0
      for (let l = 0; l <= length; l += 0.5) {
        const p = path.getPointAtLength(l).matrixTransform(toScreen)
        const d = Math.hypot(p.x - px, p.y - py)
        if (d < best) {
          best = d
          at = l
        }
      }
      return { distance: best, progress: at, length }
    })
  }, cable)
}

// Walks the path a person walks: design a flow, run it, watch it move, reload and find it where it stopped.
// Needs the Inngest dev server running (see README). The Demo provider does all the work; no real agent runs.
test('design, run, skip, reach the human gate, reload', async ({ page }) => {
  await recordStates(page)
  await page.goto('/canvas/demo')

  // Design: switch the Tests block off.
  await page.getByTestId('node-tests').click()
  await page.getByRole('checkbox', { name: 'Enabled' }).uncheck()
  await expect(page.getByTestId('node-tests')).toContainText('Off')

  // Run.
  await page.getByLabel('What should the agents do?').fill('Add a dark mode toggle')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText('Demo', { exact: true })).toBeVisible({ timeout: 30_000 })

  // The flow particles travel the cable into Build while it runs. Sample them several times: each must sit on the
  // real cable (not just inside its bounding box) and they must advance along it.
  const cable = 'plan->build'
  await expect(page.getByTestId(`particles-${cable}`)).toBeAttached({ timeout: 30_000 })
  const samples: Sample[][] = []
  for (let i = 0; i < 4; i++) {
    samples.push(await sampleParticles(page, cable))
    await page.waitForTimeout(200)
  }
  for (const taken of samples) {
    expect(taken.length).toBeGreaterThan(0)
    for (const s of taken) expect(s.distance).toBeLessThan(2)
  }
  const first = samples[0] ?? []
  first.forEach((_, dot) => {
    const along = samples.map(taken => taken[dot]?.progress ?? NaN)
    const deltas = along.slice(1).map((p, i) => p - (along[i] ?? NaN))
    // Forward motion, apart from at most one wrap back to the start of the cable.
    expect(deltas.filter(d => d > 0.5).length).toBeGreaterThanOrEqual(2)
    for (const d of deltas) expect(d > 0.5 || d < -(first[dot]?.length ?? 0) / 2).toBe(true)
  })

  // Watch: Tests is skipped and the flow stops at the human gate.
  await expect(page.getByTestId('node-tests')).toHaveAttribute('data-state', 'skipped', { timeout: 30_000 })
  await expect(page.getByTestId('node-human')).toHaveAttribute('data-state', 'waiting_approval', { timeout: 30_000 })
  await expect(page.getByTestId('node-build')).toHaveAttribute('data-state', 'passed')

  // Build was seen running, then passing, in that order: observed, not sampled.
  const build = await page.evaluate(() => window.__states['node-build'] ?? [])
  expect(build).toContain('running')
  expect(build.indexOf('running')).toBeLessThan(build.indexOf('passed'))
  // Tests never ran.
  expect(await page.evaluate(() => window.__states['node-tests'] ?? [])).not.toContain('running')

  // Reload: the run and the draft are where we left them.
  await page.reload()
  await expect(page.getByTestId('node-human')).toHaveAttribute('data-state', 'waiting_approval')
  await expect(page.getByTestId('node-tests')).toHaveAttribute('data-state', 'skipped')
  await expect(page.getByTestId('node-tests')).toContainText('Off')
})

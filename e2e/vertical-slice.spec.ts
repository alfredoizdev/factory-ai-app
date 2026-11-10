import { expect, test } from '@playwright/test'

// A cold dev server compiles each route on first use. Build is only "running" for about a second, so without this
// the slow first compile of the run routes could swallow that window and fail the test for a reason unrelated to the app.
test.beforeAll(async ({ request }) => {
  await request.get('/api/inngest')
  await request.post('/api/workflows/warm-up/runs', { data: { request: 'warm-up' } })
  await request.get('/api/runs/warm-up')
  await request.get('/api/runs/warm-up/events', { timeout: 10_000 }).catch(() => undefined)
})

// Walks the path a person walks: design a flow, run it, watch it move, reload and find it where it stopped.
// Needs the Inngest dev server running (see README). The Demo provider does all the work; no real agent runs.
test('design, run, skip, reach the human gate, reload', async ({ page }) => {
  await page.goto('/canvas/demo')

  // Design: switch the Tests block off.
  await page.getByTestId('node-tests').click()
  await page.getByRole('checkbox', { name: 'Enabled' }).uncheck()
  await expect(page.getByTestId('node-tests')).toContainText('Off')

  // Run.
  await page.getByLabel('What should the agents do?').fill('Add a dark mode toggle')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText('Demo', { exact: true })).toBeVisible({ timeout: 30_000 })

  // Watch: Build runs, Tests is skipped, the flow stops at the human gate.
  await expect(page.getByTestId('node-build')).toHaveAttribute('data-state', 'running', { timeout: 30_000 })
  await expect(page.getByTestId('node-tests')).toHaveAttribute('data-state', 'skipped', { timeout: 30_000 })
  await expect(page.getByTestId('node-human')).toHaveAttribute('data-state', 'waiting_approval', { timeout: 30_000 })
  await expect(page.getByTestId('node-build')).toHaveAttribute('data-state', 'passed')

  // Reload: the run and the draft are where we left them.
  await page.reload()
  await expect(page.getByTestId('node-human')).toHaveAttribute('data-state', 'waiting_approval')
  await expect(page.getByTestId('node-tests')).toHaveAttribute('data-state', 'skipped')
  await expect(page.getByTestId('node-tests')).toContainText('Off')
})

import { defineConfig } from '@playwright/test'

// The suite starts the Next dev server itself, on its own throwaway database so a stale
// `.factory/factory.db` can never decide what the test sees. The Inngest dev server is NOT started here:
// start it yourself (`npx inngest-cli dev`) before running, because executing a run needs it.
const PORT = 3100
const DB = 'e2e/.tmp/factory.db'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `rm -f ${DB} ${DB}-wal ${DB}-shm && mkdir -p e2e/.tmp && npm run db:migrate && npm run seed && npx next dev -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/canvas/demo`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { FACTORY_DEMO_STEP_DELAY_MS: '600', INNGEST_DEV: '1', FACTORY_DB_PATH: DB, NEXT_DIST_DIR: '.next-e2e' },
  },
})

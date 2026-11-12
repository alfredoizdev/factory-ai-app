import { projectEnv } from '@/engine/child-env'
import { runTestCommand } from '@/engine/test-runner'

test("a project's commands never get this app's own settings or secrets", () => {
  const env = projectEnv({ CI: '1' }, {
    PATH: '/usr/bin',
    HOME: '/Users/me',
    ANTHROPIC_API_KEY: 'k',
    NODE_ENV: 'development',
    NEXT_RUNTIME: 'nodejs',
    __NEXT_PRIVATE_ORIGIN: 'x',
    INNGEST_DEV: 'http://127.0.0.1:8288',
    FACTORY_DB: 'local',
    DATABASE_URL: 'postgres://secret',
    DATABASE_URL_UNPOOLED: 'postgres://secret',
    NEON_BRANCH: 'production',
    R2_SECRET_ACCESS_KEY: 'secret',
    PORT: '4100',
  })
  expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/me', ANTHROPIC_API_KEY: 'k', CI: '1' })
})

test('a check does not inherit NODE_ENV=development from the app that runs it', async () => {
  const before = process.env.NODE_ENV
  ;(process.env as Record<string, string>).NODE_ENV = 'development'
  try {
    const run = await runTestCommand('echo "env=[$NODE_ENV]"', process.cwd(), new AbortController().signal)
    expect(run.outputTail).toContain('env=[]')
  } finally {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = before
  }
})

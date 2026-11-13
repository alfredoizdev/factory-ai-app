import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    // One computer for every test: runs created in a test are "here".
    env: { FACTORY_MACHINE_ID: 'test-machine', FACTORY_MACHINE_NAME: 'Test Mac' },
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    // Many tests run real git in a temporary folder: on a busy computer that takes longer than the default 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})

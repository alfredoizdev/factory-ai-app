import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCommandFor, installDependencies } from '@/engine/install'

const dir = (...files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'factory-install-'))
  for (const f of files) writeFileSync(join(d, f), f === 'package.json' ? '{"name":"x","version":"1.0.0"}' : '')
  return d
}

test('the lockfile decides the install command', () => {
  expect(installCommandFor(dir('package.json', 'pnpm-lock.yaml'))).toMatch(/^pnpm install --frozen-lockfile/)
  expect(installCommandFor(dir('package.json', 'yarn.lock'))).toMatch(/^yarn install/)
  expect(installCommandFor(dir('package.json', 'package-lock.json'))).toMatch(/^npm ci/)
  expect(installCommandFor(dir('package.json'))).toMatch(/^npm install/)
  expect(installCommandFor(dir())).toBeNull()
})

test('a folder with nothing to install installs nothing', async () => {
  expect(await installDependencies(dir())).toBeNull()
})

test('a real install in a folder with no dependencies succeeds', async () => {
  const result = await installDependencies(dir('package.json'))
  expect(result).toMatchObject({ command: expect.stringMatching(/^npm install/), ok: true })
}, 60_000)

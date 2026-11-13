import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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

test('a project with a lock file installs from it exactly as before; one without gets none written', () => {
  expect(installCommandFor(dir('package.json', 'package-lock.json'))).toBe('npm ci --prefer-offline --no-audit --no-fund')
  expect(installCommandFor(dir('package.json'))).toBe('npm install --no-package-lock --no-audit --no-fund')
})

test('a real install in a folder with no dependencies succeeds, and leaves no lock file behind', async () => {
  const d = dir('package.json')
  const result = await installDependencies(d)
  expect(result).toMatchObject({ command: expect.stringMatching(/^npm install/), ok: true })
  // The app's own install must not add a file the task would then count as its change.
  expect(existsSync(join(d, 'package-lock.json'))).toBe(false)
}, 60_000)

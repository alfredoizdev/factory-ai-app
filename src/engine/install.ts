import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runTestCommand } from '@/engine/test-runner'

// The agent's copy is a fresh git worktree: everything git ignores, node_modules first, is missing. Without it the
// project's own tests cannot even load, so the copy gets its dependencies installed once, before the builder starts,
// the way the project installs them (its lockfile decides). Only these fixed commands are ever run here.

const INSTALL_TIMEOUT_MS = 10 * 60_000

/** The install command for a folder, from its lockfile; null when there is nothing to install. */
export function installCommandFor(dir: string): string | null {
  const has = (f: string) => existsSync(join(dir, f))
  if (!has('package.json')) return null
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile --prefer-offline'
  if (has('yarn.lock')) return 'yarn install --frozen-lockfile'
  if (has('bun.lockb') || has('bun.lock')) return 'bun install --frozen-lockfile'
  if (has('package-lock.json')) return 'npm ci --prefer-offline --no-audit --no-fund'
  // No lock file: none is written either, so the install leaves nothing behind that would count as the task's change.
  return 'npm install --no-package-lock --no-audit --no-fund'
}

export type InstallResult = { command: string; ok: boolean; durationMs: number; outputTail: string }

/** Installs the folder's dependencies. Never throws: a failed install is reported, and the run carries on. */
export async function installDependencies(dir: string, signal?: AbortSignal): Promise<InstallResult | null> {
  const command = installCommandFor(dir)
  if (!command) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const run = await runTestCommand(command, dir, controller.signal)
    return { command, ok: run.started && run.exitCode === 0, durationMs: run.durationMs, outputTail: run.outputTail }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

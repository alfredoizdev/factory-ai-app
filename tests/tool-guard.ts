import type * as ChildProcess from 'node:child_process'

// The test-wide guard against the real `gh` and `claude` (see setup.ts). Kept apart so its own test can wrap a stand-in
// module and see it refuse, without starting anything.

/** The programs no test may start for real. */
export const REFUSED = ['gh', 'claude'] as const

/** What reached a refused program since the last test ended; setup.ts fails the test with the first one. */
export const refusedRealTools: string[] = []

export const refusal = (tool: string) =>
  `A test tried to run the real \`${tool}\`. Tests must never reach GitHub or the model: pass a fake (a fake gh, ask or spawn) instead.`

/** The refused program a starter was asked to run, if any: the file itself, or the first word of a command run by a shell. */
function programOf(file: unknown): string | null {
  if (typeof file !== 'string') return null
  const names = [file, file.trim().split(/\s+/)[0] ?? ''].map(f => f.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? '')
  return names.find(n => (REFUSED as readonly string[]).includes(n)) ?? null
}

function guarded<F extends (...a: never[]) => unknown>(start: F): F {
  return ((...args: Parameters<F>) => {
    const tool = programOf(args[0])
    if (tool) {
      const message = refusal(tool)
      refusedRealTools.push(message)
      throw new Error(message)
    }
    return start(...args)
  }) as F
}

/** The module with every way of starting a program wrapped; everything else is the real module. */
export function toolGuard(real: typeof ChildProcess): typeof ChildProcess {
  const wrapped = {
    execFile: guarded(real.execFile),
    execFileSync: guarded(real.execFileSync),
    spawn: guarded(real.spawn),
    spawnSync: guarded(real.spawnSync),
    fork: real.fork,
    exec: guarded(real.exec),
    execSync: guarded(real.execSync),
  }
  return { ...real, ...wrapped, default: { ...real, ...wrapped } } as typeof ChildProcess
}

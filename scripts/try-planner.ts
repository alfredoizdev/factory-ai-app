// Tries the planner once with the real `claude` CLI, through the same entry the executor uses
// (`claudeProvider.execute`), and prints the planner's raw answer, how the app reads that answer, and what the
// executor receives. Needs no database. Usage:
//   npx tsx --tsconfig tsconfig.json scripts/try-planner.ts <repoDir> "<request>"
import { spawn as nodeSpawn } from 'node:child_process'

async function main() {
  // The engine modules open a database on import. This script never uses it, so it is given the in-memory one the
  // tests use, and no real database is reached: set always (an empty VITEST would not count), and the real database's
  // addresses are dropped as well, before anything is imported.
  process.env.VITEST = '1'
  for (const k of Object.keys(process.env)) if (k.includes('DATABASE_URL')) delete process.env[k]
  const { readPlannerAnswer } = await import('@/engine/plan')
  const { createClaudeProvider } = await import('@/providers/claude')
  const [repoDir, request] = process.argv.slice(2)
  if (!repoDir || !request) {
    console.error('usage: try-planner.ts <repoDir> <request>')
    process.exit(2)
  }
  // The provider's done event carries the parsed plan, not the planner's words; the words are read off the CLI's own
  // output as they pass (its last "result" line).
  let raw: string | undefined
  const spawn = ((...a: Parameters<typeof nodeSpawn>) => {
    const child = nodeSpawn(...a)
    let buf = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const o = JSON.parse(line) as { type?: string; result?: unknown }
          if (o.type === 'result' && typeof o.result === 'string') raw = o.result
        } catch {
          /* not a JSON line */
        }
      }
    })
    return child
  }) as typeof nodeSpawn
  const provider = createClaudeProvider({ spawn })
  const controller = new AbortController()
  let received: unknown
  for await (const ev of provider.execute({ blockKind: 'plan', request, workdir: repoDir, model: 'sonnet' }, { signal: controller.signal })) {
    if (ev.type === 'error') {
      console.error(`ERROR: ${ev.message}`)
      process.exit(1)
    }
    if (ev.type === 'done') received = { plan: ev.plan, planQuestion: ev.planQuestion }
  }
  console.log('--- raw answer ---')
  console.log(raw)
  console.log('--- parse of the raw answer ---')
  console.log(JSON.stringify(raw === undefined ? null : readPlannerAnswer(raw), null, 2))
  console.log('--- what the executor receives (done event) ---')
  console.log(JSON.stringify(received, null, 2))
}

// Ends on its own once the answer is printed: nothing left open (a child, a timer) keeps it running.
main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e)
    process.exit(1)
  },
)

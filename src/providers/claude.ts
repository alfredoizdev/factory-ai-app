import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { BlockKind } from '@/domain/graph'
import { clip, redact } from '@/engine/redact'
import { changedTestFiles as gitChangedTestFiles, runTestCommand as nodeRunTests } from '@/engine/test-runner'
import { CLAUDE_PROVIDER_ID } from '@/providers/ids'
import { mapStreamLine } from '@/providers/claude-stream'
import type { AgentEvent, AgentExecutionInput, AgentProvider, BlockRoute, ExecutionControls } from '@/providers/types'
import { strings } from '@/ui/strings'

// The real builder. Build is the `claude` CLI, headless, inside the run's worktree; Tests is the project's own test
// command (no model involved). Every other block either records something plain (Input) or is skipped with a
// sentence saying which milestone brings it — nothing here pretends to do work it does not do.

const STDERR_TAIL = 600
/** How long the builder's processes get to exit after SIGTERM before they are killed outright. */
export const STOP_GRACE_MS = 3000

type Child = ReturnType<typeof nodeSpawn>

function signalTree(child: Child, sig: NodeJS.Signals): void {
  // The builder runs as the leader of its own process group, so the group's id is its pid: signalling -pid reaches
  // everything it started (a dev server, a watcher). Without a pid (it never started) only the handle is left.
  try {
    if (child.pid) {
      process.kill(-child.pid, sig)
      return
    }
  } catch {
    // ESRCH: the whole group is already gone.
    return
  }
  child.kill(sig)
}

/** Asks the builder and everything it started to stop, then makes sure they have. */
function stopTree(child: Child): void {
  signalTree(child, 'SIGTERM')
  setTimeout(() => signalTree(child, 'SIGKILL'), STOP_GRACE_MS).unref()
}

export type ClaudeDeps = {
  spawn?: typeof nodeSpawn
  bin?: string
  runTests?: typeof nodeRunTests
  changedTestFiles?: typeof gitChangedTestFiles
}

const SKIPPED: Partial<Record<BlockKind, string>> = {
  plan: strings.run.notYet.plan,
  review: strings.run.notYet.review,
  approve: strings.run.notYet.review,
  ship: strings.run.notYet.ship,
}

export function routeFor(kind: BlockKind, context: { testCommand?: string | null }): BlockRoute {
  const reason = SKIPPED[kind]
  if (reason) return { mode: 'skip', reason }
  if (kind === 'tests' && !context.testCommand?.trim()) return { mode: 'skip', reason: strings.run.notYet.noTestCommand }
  return { mode: 'execute' }
}

export function claudeArgs(prompt: string): string[] {
  // The prompt is an argument, never interpolated into a shell. bypassPermissions is the design's unattended builder
  // (§6): it works inside its worktree without a prompt per command. It is not a sandbox.
  return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
}

async function* runBuilder(input: AgentExecutionInput, { signal }: ExecutionControls, deps: Required<ClaudeDeps>): AsyncGenerator<AgentEvent> {
  if (!input.workdir) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.noWorkdir }
    return
  }
  const workdir = input.workdir
  let child: Child
  try {
    child = deps.spawn(deps.bin, claudeArgs(strings.providers.claude.buildPrompt(input.request)), {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      // Its own process group, so stopping it stops what it started too.
      detached: true,
    })
  } catch {
    yield { type: 'error', source: 'system', message: strings.providers.claude.notFound }
    return
  }

  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-STDERR_TAIL * 4)
  })
  const exited = new Promise<{ code: number | null; missing: boolean }>(resolve => {
    child.once('error', (e: NodeJS.ErrnoException) => resolve({ code: null, missing: e.code === 'ENOENT' }))
    child.once('close', (code: number | null) => resolve({ code, missing: false }))
  })
  const stop = () => stopTree(child)
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })

  try {
    if (child.stdout) {
      for await (const raw of createInterface({ input: child.stdout })) {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }
        for (const ev of mapStreamLine(parsed, workdir)) {
          yield ev
          if (ev.type === 'done' || ev.type === 'error') return // exactly one terminal event
        }
      }
    }
    const { code, missing } = await exited
    if (signal.aborted) return
    if (missing) {
      yield { type: 'error', source: 'system', message: strings.providers.claude.notFound }
      return
    }
    const tail = clip(redact(stderr.trim()).slice(-STDERR_TAIL), STDERR_TAIL)
    // The app's sentence, with the CLI's own stderr appended (redacted): neither part is a model's claim about the work.
    yield { type: 'error', source: 'system', message: [strings.providers.claude.exitedWithoutResult(code), tail].filter(Boolean).join(' ') }
  } finally {
    signal.removeEventListener('abort', stop)
    // Whatever the builder left running — itself after an abort, or a background process it started and walked away
    // from — must not keep writing into the worktree once the block is over.
    stopTree(child)
  }
}

async function* runTests(input: AgentExecutionInput, { signal }: ExecutionControls, deps: Required<ClaudeDeps>): AsyncGenerator<AgentEvent> {
  const command = input.testCommand?.trim()
  if (!input.workdir || !command) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.noWorkdir }
    return
  }
  yield { type: 'step', text: strings.providers.claude.runningTests(command) }
  const run = await deps.runTests(command, input.workdir, signal)
  if (signal.aborted) return // cancelled: the executor records that, and nothing was measured
  // Nothing ran, so there is no evidence to record — only the fact that it could not start. Not retried either.
  if (!run.started) {
    yield { type: 'error', source: 'system', cause: 'tests_failed', message: strings.run.testsDidNotStart(command) }
    return
  }
  // Checked after the run, against the base commit: anything the builder did to the tests is on the record with the result.
  yield { type: 'evidence', kind: 'test_run', data: { ...run, changedTestFiles: deps.changedTestFiles(input.workdir, input.baseCommit) } }
  const c = run.counts
  if (run.signal) {
    // Killed (out of memory, a crash): a measured failure, recorded and not run a second time.
    yield { type: 'error', source: 'system', cause: 'tests_failed', message: strings.run.testsKilled(run.signal) }
    return
  }
  if (run.exitCode === 0) {
    yield { type: 'done', source: 'system', summary: c ? strings.summary.testsPassed(c.passed, c.total) : strings.summary.passedWithoutCounts }
  } else {
    yield {
      type: 'error',
      source: 'system',
      cause: 'tests_failed',
      message: c ? strings.summary.testsFailed(c.passed, c.failed, c.total) : strings.summary.failedWithoutCounts,
    }
  }
}

export function createClaudeProvider(deps: ClaudeDeps = {}): AgentProvider {
  const full: Required<ClaudeDeps> = {
    spawn: deps.spawn ?? nodeSpawn,
    bin: deps.bin ?? 'claude',
    runTests: deps.runTests ?? nodeRunTests,
    changedTestFiles: deps.changedTestFiles ?? gitChangedTestFiles,
  }
  return {
    id: CLAUDE_PROVIDER_ID,
    isDemo: false,
    needsWorkspace: true,
    route: routeFor,
    async *execute(input, controls) {
      if (input.blockKind === 'input') {
        yield { type: 'step', text: strings.providers.claude.recordingRequest }
        yield { type: 'done', source: 'system', summary: strings.summary.input.passed }
        return
      }
      if (input.blockKind === 'tests') {
        yield* runTests(input, controls, full)
        return
      }
      yield* runBuilder(input, controls, full)
    },
  }
}

export const claudeProvider: AgentProvider = createClaudeProvider()

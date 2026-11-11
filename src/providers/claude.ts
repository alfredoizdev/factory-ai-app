import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { BlockKind } from '@/domain/graph'
import { clip, redact } from '@/engine/redact'
import { parsePlan, workList } from '@/engine/plan'
import { parseReview, whereOf } from '@/engine/review'
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
  /** A fingerprint of the worktree's files (tracked changes and untracked files): the reviewer must leave it unchanged. */
  snapshot?: (workdir: string) => string
}

// Approve is summed up by the executor from the reviews, not run by the agent; Ship happens from the result card.
const SKIPPED: Partial<Record<BlockKind, string>> = {
  ship: strings.run.notYet.ship,
}

export function routeFor(kind: BlockKind, context: { testCommand?: string | null }): BlockRoute {
  const reason = SKIPPED[kind]
  if (reason) return { mode: 'skip', reason }
  if (kind === 'tests' && !context.testCommand?.trim()) return { mode: 'skip', reason: strings.run.notYet.noTestCommand }
  return { mode: 'execute' }
}

/** A model name as the CLI takes it ("opus", "sonnet", "claude-opus-5-5", "opus[1m]"). Never starts with "-". */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/

export function claudeArgs(prompt: string, imageDir?: string, model?: string): string[] {
  // The prompt is an argument, never interpolated into a shell. bypassPermissions is the design's unattended builder
  // (§6): it works inside its worktree without a prompt per command. It is not a sandbox. With images, their folder
  // is added as a directory the agent may read, and nothing else.
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
  const withModel = model ? [...args, '--model', model] : args
  return imageDir ? [...withModel, '--add-dir', imageDir] : withModel
}

/** The reviewer's arguments: read-only tools only. Anything else it asks for is refused, since nobody is there to allow it. */
export function reviewerArgs(prompt: string, model?: string): string[] {
  const readOnly = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git show:*)']
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--allowedTools', ...readOnly, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit']
  return model ? [...args, '--model', model] : args
}

function gitSnapshot(workdir: string): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  return createHash('sha256').update(git(['status', '--porcelain', '--untracked-files=all'])).update(git(['diff', 'HEAD'])).digest('hex')
}

async function* runReviewer(input: AgentExecutionInput, controls: ExecutionControls, deps: Required<ClaudeDeps>): AsyncGenerator<AgentEvent> {
  if (!input.workdir) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.noWorkdir }
    return
  }
  if (!input.baseCommit) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.noBase }
    return
  }
  if (input.model !== undefined && !MODEL_NAME.test(input.model)) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.badModel(input.model) }
    return
  }
  const workdir = input.workdir
  const before = deps.snapshot(workdir)
  for await (const ev of runClaude(deps, workdir, reviewerArgs(strings.providers.claude.reviewPrompt(input.request, input.baseCommit), input.model), controls)) {
    if (ev.type !== 'done') {
      yield ev
      if (ev.type === 'error') return
      continue
    }
    // Read-only is the rule and this is the check: a reviewer that changed anything is not a review.
    if (deps.snapshot(workdir) !== before) {
      yield { type: 'error', source: 'system', message: strings.review.reviewerChangedFiles }
      return
    }
    const review = parseReview(ev.fullText ?? ev.summary)
    if (!review) {
      yield { type: 'done', source: 'system', summary: strings.review.unreadable, usage: ev.usage }
      return
    }
    for (const f of review.findings) yield { type: 'step', text: strings.review.found(whereOf(f), f.problem) }
    const summary = review.verdict === 'ok' ? strings.review.noProblems : strings.review.problems(review.findings.length)
    // The verdict is the reviewer's own claim about the code, so it is marked as the provider's words.
    yield { type: 'done', source: 'provider', summary, usage: ev.usage, review }
    return
  }
}

/** The planner: reads the project without changing it and proposes the request as a few jobs. */
async function* runPlanner(input: AgentExecutionInput, controls: ExecutionControls, deps: Required<ClaudeDeps>): AsyncGenerator<AgentEvent> {
  if (!input.workdir) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.noWorkdir }
    return
  }
  if (input.model !== undefined && !MODEL_NAME.test(input.model)) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.badModel(input.model) }
    return
  }
  const workdir = input.workdir
  const before = deps.snapshot(workdir)
  const asked = strings.providers.claude.planPrompt(input.request, input.previousRequest, input.revisionNote)
  const prompt = input.notes && input.notes.length > 0 ? `${asked}\n\n${strings.providers.claude.rulesNote(input.notes)}` : asked
  const images = input.images ?? []
  const withImages = images.length > 0 ? `${prompt}\n\n${strings.providers.claude.imagesNote(images)}` : prompt
  const args = reviewerArgs(withImages, input.model)
  for await (const ev of runClaude(deps, workdir, images.length > 0 ? [...args, '--add-dir', dirname(images[0]!)] : args, controls)) {
    if (ev.type !== 'done') {
      yield ev
      if (ev.type === 'error') return
      continue
    }
    // Planning reads; it never writes. A planner that changed anything did not plan.
    if (deps.snapshot(workdir) !== before) {
      yield { type: 'error', source: 'system', message: strings.providers.claude.plannerChangedFiles }
      return
    }
    const jobs = parsePlan(ev.fullText ?? ev.summary)
    if (!jobs) {
      yield { type: 'done', source: 'system', summary: strings.plan.unreadable, usage: ev.usage }
      return
    }
    for (const [i, j] of jobs.entries()) yield { type: 'step', text: strings.plan.jobStep(i + 1, j.title) }
    // The jobs are the planner's proposal, so the summary is marked as the provider's words.
    yield { type: 'done', source: 'provider', summary: strings.plan.proposed(jobs.length), usage: ev.usage, plan: jobs }
    return
  }
}

async function* runBuilder(input: AgentExecutionInput, controls: ExecutionControls, deps: Required<ClaudeDeps>): AsyncGenerator<AgentEvent> {
  if (!input.workdir) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.noWorkdir }
    return
  }
  const workdir = input.workdir
  // A model name that is not one could be read as another option; it is refused, plainly, before anything starts.
  if (input.model !== undefined && !MODEL_NAME.test(input.model)) {
    yield { type: 'error', source: 'system', message: strings.providers.claude.badModel(input.model) }
    return
  }
  const prompt = input.revisionNote
    ? input.revisionFrom === 'reviewer'
      ? strings.providers.claude.reviewerRevisePrompt(input.request, input.revisionNote)
      : strings.providers.claude.revisePrompt(input.request, input.revisionNote)
    : input.previousRequest
      ? strings.providers.claude.followUpPrompt(input.previousRequest, input.request)
      : strings.providers.claude.buildPrompt(input.request)
  // The plan the person checked, on the first round: the builder works through it. Later rounds carry their own note.
  const ruled = input.notes && input.notes.length > 0 ? `${prompt}\n\n${strings.providers.claude.rulesNote(input.notes)}` : prompt
  const planned = input.jobs && input.jobs.length > 0 && !input.revisionNote ? `${ruled}\n\n${strings.providers.claude.workListNote(workList(input.jobs))}` : ruled
  const images = input.images ?? []
  const withImages = images.length > 0 ? `${planned}\n\n${strings.providers.claude.imagesNote(images)}` : planned
  yield* runClaude(deps, workdir, claudeArgs(withImages, images.length > 0 ? dirname(images[0]!) : undefined, input.model), controls)
}

/** Runs the claude CLI in the worktree with the given arguments and turns its stream into agent events. */
async function* runClaude(deps: Required<ClaudeDeps>, workdir: string, args: string[], { signal }: ExecutionControls): AsyncGenerator<AgentEvent> {
  let child: Child
  try {
    child = deps.spawn(deps.bin, args, {
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
    snapshot: deps.snapshot ?? gitSnapshot,
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
      if (input.blockKind === 'plan') {
        yield* runPlanner(input, controls, full)
        return
      }
      if (input.blockKind === 'review') {
        yield* runReviewer(input, controls, full)
        return
      }
      yield* runBuilder(input, controls, full)
    },
  }
}

export const claudeProvider: AgentProvider = createClaudeProvider()

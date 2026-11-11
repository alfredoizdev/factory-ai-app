# M3a — Real Agent, Worktree, Evidence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run can use a real `claude` agent that writes code in its own git worktree, the canvas shows what it is actually doing, and the project's tests run as evidence the card renders differently from anything a model said.

**Architecture:** A second `AgentProvider` (`claude`) joins the demo one. The executor creates one worktree per real run, hands its path to the provider, and records two new kinds of fact: usage the CLI reported, and evidence from the test runner (a non-model process). The builder is the `claude` CLI in headless stream-json mode; its stream is mapped to steps and redacted before anything is stored. Blocks whose behaviour belongs to a later milestone are skipped visibly with a reason, never faked.

**Tech Stack:** existing (Next 16, React 19, Drizzle/SQLite, Inngest, vitest). No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-10-ai-factory-design.md` — §7 steps 5–7, §7 Data model "Worktree lifecycle", §6 "Settled after the builder review", §8 M3, §8.1.

**Scope:** this is the first half of M3, agreed with the user on 2026-11-11. The editable planner, ContextForge retrieval/write-back and the two-concurrent-runs demonstration are M3b. M3's own done-when is therefore not claimed by this plan.

## Calls made in this plan

- **Runtape's hooks are not installed.** §7 asks the builder to read Runtape's hook mapping first; it was read (`hindsight-cli/src/lib/hook-mapping.ts`). Installing hooks writes to `~/.claude/settings.json`, which would change every Claude Code session on this machine, and the app spawns the CLI itself, so `--output-format stream-json` delivers the same tool-call events on stdout with no global change. Runtape's idea of collapsing tool-result errors into one shape is reused in the stream mapper. Revisit if subagent capture is needed (stream-json does not cover `Task` internals either).
- **Builder tokens are shown, builder cost is not.** The CLI reports real token counts; its dollar figure is an API-price estimate, not what a subscription pays, so it is never stored.

## Global Constraints

- The web UI never executes an agent: API validates → persists → enqueues → the worker executes (§7 Principle).
- One worktree per run, never per job; the user's checkout is never touched (§6).
- Branch name `factory/<run-slug>`; a worktree is never deleted by this milestone (§7 Worktree lifecycle).
- The builder runs unattended inside its worktree, no per-command prompts (§6). It is *not* a sandbox; the UI must not call it one.
- Builder cost is "not reported", never 0 and never the CLI's API-price estimate (§6 billing split). Tokens the CLI reports are shown as reported.
- Evidence comes only from a non-model process; the `test ✓` signal is derived from a test-run record, never from the agent (§7 step 7).
- The configured test command is the allow-list; nothing else runs as an evidence step (§7 step 7).
- No secret may reach an event payload or the browser (carried obligation, M0–M2 review).
- No mock presented as an integration: an unwired block says it is not wired (§9).
- All user-facing copy in `src/ui/strings.ts`. Every mutating route passes `rejectCrossSite`.

## Review Focus

1. **A secret in the agent's own output** (an `.env` it cats, a token in a command line) → it never reaches `events.payload_json`. Pinned in Task 2.
2. **`claude` not installed, or exits non-zero before any output** → the Build node fails with a recorded cause and the CLI's stderr tail (redacted), never "passed". Pinned in Task 4.
3. **The repo path is not a git repo, has no commits, or does not exist** → choosing the claude provider is refused with a sentence, and no run is created. Pinned in Task 6.
4. **The test command exits non-zero but prints no parseable counts** → Tests fails with "Failed. No test counts were recorded.", no invented numbers. Pinned in Task 3.
5. **Cancel while `claude` is running** → the child process is killed (no orphan writing into the worktree). Pinned in Task 4.

---

### Task 1: Project repo settings and run workspace columns

**Files:** Modify `src/db/schema.ts`; generate `drizzle/0003_*.sql`; Test `tests/db/schema.test.ts`

**Interfaces — Produces:** `projects.repoPath: text | null`, `projects.testCommand: text | null`; `runs.worktreePath`, `runs.branch`, `runs.baseCommit`: `text | null`.

- [ ] Test: inserting a project without the new fields leaves them `null`; a run row accepts the three workspace columns.
- [ ] `npx drizzle-kit generate` → one new migration; `npm run db:migrate` applies on an existing `.factory/factory.db` without data loss.
- [ ] `npx vitest run tests/db` passes. Commit.

### Task 2: Redaction

**Files:** Create `src/engine/redact.ts`; Test `tests/engine/redact.test.ts`

**Interfaces — Produces:** `redact(text: string, env?: Record<string, string | undefined>): string`, `clip(text: string, max: number): string`.

- [ ] Tests: `sk-ant-…`, `ghp_…`, `gho_…`, `github_pat_…`, `AKIA…`, `xox[bp]-…`, `Bearer <token>`, a `-----BEGIN … PRIVATE KEY-----` block, and `API_KEY=value` / `"password": "value"` assignments are replaced by `[redacted]`; the value of any env var whose name matches `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` and is ≥ 8 chars is replaced wherever it appears; ordinary text is unchanged; `clip` cuts to `max` chars with `…`.
- [ ] Implement with an ordered regex list; env values matched literally (escaped).
- [ ] Commit.

### Task 3: Test runner (evidence producer)

**Files:** Create `src/engine/test-runner.ts`; Test `tests/engine/test-runner.test.ts`

**Interfaces — Produces:**
```ts
type TestRun = { command: string; exitCode: number | null; durationMs: number;
  counts: { passed: number; failed: number; total: number } | null; outputTail: string }
runTestCommand(command: string, cwd: string, signal: AbortSignal): Promise<TestRun>
parseCounts(output: string): TestRun['counts']
detectTestCommand(repoPath: string): string | null   // package.json scripts.test → "npm test"
```

- [ ] Tests: `parseCounts` reads vitest (`Tests  3 passed | 1 failed (4)` and `Tests  4 passed (4)`), jest (`Tests: 1 failed, 3 passed, 4 total`) and returns `null` for anything else; `runTestCommand('exit 3', tmp)` → `exitCode 3, counts null`; `outputTail` is the last 4 000 chars, redacted; abort kills the process and resolves with `exitCode null`; `detectTestCommand` returns `npm test` only when `scripts.test` exists and is not npm's default `echo "Error: no test specified" && exit 1`.
- [ ] Implement with `spawn('sh', ['-c', command], { cwd, detached: true })`; abort kills the process group. The command string is only ever the project's configured one.
- [ ] Commit.

### Task 4: The claude provider

**Files:** Modify `src/providers/types.ts`, `src/providers/ids.ts`; Create `src/providers/claude.ts`, `src/providers/claude-stream.ts`; Test `tests/providers/claude-stream.test.ts`, `tests/providers/claude.test.ts`

**Interfaces:**
- Contract changes (demo unaffected): `AgentExecutionInput` gains `workdir?: string`, `testCommand?: string | null`. `AgentEvent` gains `{ type: 'evidence'; kind: 'test_run'; data: TestRun }`; `done` gains `usage?: { tokens: number | null }` and `source?: 'provider' | 'system'`. `AgentProvider` gains optional `route(kind: BlockKind): { mode: 'execute' } | { mode: 'skip'; reason: string }`.
- `CLAUDE_PROVIDER_ID = 'claude'` in `ids.ts`.
- `mapStreamLine(line: unknown): AgentEvent[]` (pure) and `createClaudeProvider(deps?: { spawn?: typeof spawn; bin?: string; runTests?: typeof runTestCommand }): AgentProvider`.

Routing (copy in `strings.run.notYet`): `input` → execute (system: "Request recorded."), `plan` → skip "The editable plan arrives in the next step of this milestone.", `build` → execute (the CLI), `tests` → execute (the test runner, or skip "No test command is set for this project." when none), `review`/`approve` → skip "Reviews arrive in milestone 4.", `ship` → skip "Shipping arrives in milestone 6.", `human` → never routed (the executor parks it).

- [ ] Stream tests: `tool_use` Edit/Write/MultiEdit → step `Editing <relative path>`; Read → `Reading <path>`; Bash → `Running: <command, redacted, clipped to 120>`; Grep/Glob → `Searching the code`; other tools → `Using <name>`; a `result` with `is_error: false` → `done` with `summary` = clipped result text, `source: 'provider'`, `usage.tokens` = input+output+cache tokens when present; `is_error: true` → `error`; non-JSON or unknown lines → `[]`.
- [ ] Provider tests with a fake `spawn`: argv is exactly `['-p', <prompt>, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']`, `cwd` is `workdir`, prompt is passed as an argument (never through a shell); a missing `workdir` yields `error` before spawning; exit ≠ 0 with no `result` → `error` with redacted stderr tail; ENOENT → `error` "The claude command was not found on this computer."; abort sends SIGTERM to the child; `tests` kind yields one `evidence` then `done` (exit 0, `source: 'system'`, summary from `strings.summary.testsPassed`/`passedWithoutCounts`) or `error` (non-zero, `testsFailed`/`failedWithoutCounts`).
- [ ] Prompt (in `strings.providers.claude.buildPrompt(request)`): the request, plus: work only inside the current directory; commit nothing; do not push; finish with one sentence on what changed.
- [ ] Commit.

### Task 5: Executor — worktree, routing, evidence, usage

**Files:** Create `src/engine/worktree.ts`; Modify `src/engine/inngest/execute-run.ts`, `src/engine/events.ts`; Test `tests/engine/worktree.test.ts`, `tests/engine/execute-run.test.ts`

**Interfaces:**
- `createRunWorktree(repoPath: string, runId: string, root: string): { path: string; branch: string; baseCommit: string }` — `git worktree add -b factory/<runId lowercased> <root>/<runId> HEAD`, where `root` defaults to `<app cwd>/.factory/worktrees`. Idempotent on replay (existing path + branch → returned as is).
- New event types: `run.workspace` (payload `{ branch, path, baseCommit }`), `node.evidence` (payload `{ blockId, kind: 'test_run', exitCode, durationMs, counts }` — no output text).
- `ExecutorDeps` gains `createWorktree`.

- [ ] Worktree tests against a temp repo: creates the branch off HEAD, leaves the original checkout's `git status` untouched, replay returns the same result, a repo with no commits throws.
- [ ] Executor tests with a fake provider: a claude run writes `run.workspace` before the first node; a routed `skip` ends the node `skipped` with that reason; an `evidence` event writes one `evidence` row (source `test-runner`, dataJson incl. redacted tail) and one `node.evidence` event; `done.usage` writes a `usage_records` row with `costCents: null`; `done.source: 'system'` is stored as `summarySource: 'system'`; every `node.step` text passes through `redact`; demo runs are unchanged (existing tests stay green).
- [ ] A `done` whose `source` is not `'system'` also writes one `claims` row with the summary text: the model's sentence is stored as a claim, separately from evidence (§7 Data model).
- [ ] `resolveProvider` knows `claude`. Commit.

### Task 6: Choosing the agent and the repository

**Files:** Modify `src/engine/run.ts`, `src/app/api/workflows/[id]/runs/route.ts`, `src/ui/canvas/CanvasScreen.tsx`, `src/ui/strings.ts`; Create `src/app/api/projects/[id]/route.ts`; Test `tests/engine/run.test.ts`, `tests/engine/project-settings.test.ts`

**Interfaces:** `setProjectRepo(projectId, repoPath: string): { repoPath; testCommand }` (validates absolute, exists, `git rev-parse --show-toplevel` equals it, has HEAD; pre-fills `testCommand` via `detectTestCommand` when unset); `setTestCommand(projectId, command: string | null)`; `createRun({ workflowId, request, providerId?: 'demo' | 'claude' })` refuses `claude` without a valid repo (`RepoNotSetError`). `GET/PUT /api/projects/:id` (PUT same-origin guarded). Run POST body gains optional `provider`.

- [ ] Tests: each invalid path is refused with its own sentence and nothing is stored; `createRun` with `claude` and no repo throws and inserts no run; demo stays the default.
- [ ] UI: header gets an agent switch (`Demo` / `Claude`) and, when Claude is chosen, the repository path and test command fields with a save. The Demo badge stays tied to `providerId`. A one-line notice under the switch while Claude is chosen: "Claude works on its own in a separate copy of the repository. It is not sandboxed."
- [ ] Commit.

### Task 7: The card shows evidence and usage

**Files:** Modify `src/ui/canvas/useRunStream.ts`, `src/ui/canvas/BlockCard.tsx`; Test `tests/ui/useRunStream.test.ts`, `tests/ui/BlockCard.test.tsx`

**Interfaces:** `RawNode` gains `counts?`, `exitCode?`, `durationMs?`, `tokens?`; `NodeRunView` gains `evidence?: { counts: … | null; exitCode: number | null; durationMs: number }`. `toViews` passes `counts` into `summarize` (already supported). `node.completed` with `tokens` → `usage: { tokens, costCents: null }`.

- [ ] Tests: `node.evidence` sets the counts and the summary becomes "3 of 4 passed. 1 failed." with `summaryIsClaim: false`; the card renders an evidence strip (pips for counts, `exit 1`, duration) only when `view.evidence` exists, and a card with a claim never has one; usage from a claude build shows tokens and "Not reported" for cost.
- [ ] Commit.

### Task 8: Verify end to end against a scratch repository

- [ ] Full suite, `tsc --noEmit`, lint (0 errors), `npm run build`.
- [ ] Manual: a throwaway git repo with one failing vitest test; run with Claude and the request "make the failing test pass"; confirm the worktree and branch exist, the user's checkout is clean, steps appear live, Tests shows real counts as evidence, the run parks at Human check. Record what was observed in the ledger, including anything that did not work.

---

## Verification record (2026-11-11)

**Automated.** 366 unit tests pass, `tsc --noEmit` clean, lint 0 errors, `next build` succeeds. The Playwright e2e
fails on this branch **and on `main` identically**: it needs the Inngest dev server (`npx inngest-cli dev`), which
was not running and which this session is not permitted to start. Its one change here (finding the Demo badge by
title, since the agent switch adds a second visible "Demo") is unverified until it runs with Inngest.

**One real run**, driven through the real `orchestrateRun` with a stand-in for Inngest's step tools (the same way
the executor tests drive it; only the Inngest enqueue was not exercised). Scratch repository: a cart function with
two bugs, `node --test`, 2 of 4 passing. Request: make every test pass without changing the tests.

| Observed | Result |
|---|---|
| Worktree + branch | `factory/01m75jysw6cwrrr44x69xk2h65` off the base commit, recorded on the run |
| The person's checkout | clean, still on `main`, still containing the bugs |
| Builder | fixed both bugs in `src/cart.js`, made no commit, ~14 s for the whole run |
| Steps on the canvas | live, from real tool calls (two `Running: …` lines, clipped) |
| Model's closing sentence | stored in `claims` ("…all 4 tests now pass") |
| Evidence | `evidence` row from `test-runner`: exit 0, 4 of 4; re-run by hand in the worktree: 4 of 4 |
| Usage | 96,195 tokens reported, cost `NULL` (not reported) |
| Blocks not yet built | Plan, Review, Approve skipped with the milestone that brings them; parked at Human check |
| Secrets in the run's events | 0 matches |

**Noticed, not fixed here:**
- The builder inherits the person's global Claude Code setup: five of their SessionStart hooks fired in the
  probe run. Their plugins, MCP servers and CLAUDE.md therefore shape every build. Whether the builder should run
  with a clean setup (`--setting-sources`, `--strict-mcp-config`) is a decision for the person, not made here.
- The builder wrote the file through a shell heredoc, so the step read `Running: cat > src/cart.js …` rather than
  `Editing src/cart.js`. Honest, but less legible; a later pass could recognise a heredoc write.
- The demo project now points at the scratch repository. If that folder is deleted, a Claude run fails at the
  worktree step with a sentence saying so.

## Independent review and fixes (2026-11-11)

A fresh reviewer read the whole branch diff. Seven findings, all verified against the code before fixing:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | critical | `next dev` listened on every interface and the guard admitted header-less requests: a machine on the same network could set the test command and start a Claude run (shell + unattended agent). DNS rebinding also passed. Confirmed live: server on `*:3000`, reachable at the LAN address. | Bind dev/start/e2e to 127.0.0.1; refuse any non-loopback Host in the guard and, via `src/proxy.ts`, on every request. The running dev server was restarted on loopback. |
| 2 | important | Evidence came from tests the unattended builder could have just rewritten. | Test files, test scripts and runner config changed since the base commit are recorded with the evidence; the strip names them and drops its ✓. |
| 3 | important | App-written failures were recorded as the model's words. | `source: 'system'` on each. |
| 4 | minor | Tests killed by a signal left no evidence and re-ran. | Recorded as a measured failure; not retried. |
| 5 | minor | Cancel stopped only `claude`, not what it started. | Own process group; SIGTERM then SIGKILL. |
| 6 | minor | Exception text reached the log unredacted. | Redacted and clipped. |
| 7 | minor | Evidence and outcome in separate transactions. | One transaction. |

**Re-verified after the fixes:** 388 unit tests, `tsc` clean, lint 0 errors, and a second real run (13 s, 4 of 4,
`changedTestFiles: []`, no processes left in the worktree). The e2e remains unverified for want of Inngest.

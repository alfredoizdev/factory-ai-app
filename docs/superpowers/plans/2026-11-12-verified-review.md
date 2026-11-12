# Decision Register and Verified Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's change is read by up to three focused reviewers, every finding is checked before the builder sees it, critical ones reach the person as a question with options, each fix is made and re-checked on its own, and every outcome lands in a numbered project register.

**Architecture:** The single Review block becomes a stage the executor drives in durable steps: reviewers → app checks (cite, duplicates, order) → one verifier per finding in a throwaway copy → the app re-runs the reproduction → low risk is fixed, high risk parks the run on a question → fixes one at a time behind a snapshot → one more bounded review of what the fixes changed. Findings and questions are rows the executor acts on (never the event alone); the register extends `project_notes` with a number and a kind. Pure logic lives in small new modules; `execute-run.ts` only orchestrates.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Drizzle on Postgres (PGlite in tests), Inngest steps, the `claude` CLI adapter, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-12-verified-implementation-design.md` — this plan implements Piece 1 (§3.1, §5, the parts of §6.4 and §10 that Piece 1 touches). Read §2, §3, §3.1, §5 and §10 before starting.

## Global Constraints

- Develop and verify on the local test database (`npm run dev`). Schema changes: edit `src/db/schema.ts`, run `npm run db:generate`, commit the generated file in `drizzle-pg/`. Never run `npm run db:migrate:neon` as part of this plan.
- Tests use PGlite through `migrateDb()` (see `tests/engine/execute-run.test.ts`); never Neon.
- Every sentence a person reads lives in `src/ui/strings.ts`, in plain words a non-programmer understands. No file path, register number or command output on a card's first level (§10).
- What a model says is a claim (`source: 'provider'`, shown as "AI says"). What the app ran is evidence. Never show a claim with a measured tick.
- The executor acts on recorded rows, never on an Inngest event alone (as `readRecordedDecision` does).
- Reviewers and the planner stay read-only (`reviewerArgs`); a verifier never runs in the task's working copy.
- Loops are bounded: `MAX_REVIEW_ROUNDS = 2` (exists), `MAX_FINDINGS = 10` (exists in `review.ts`), `MAX_FIX_ATTEMPTS = 2` (new).
- Nothing polls the database unless a run is live or waiting (`relay.ts` rule).
- The demo provider's path through the Review block must stay exactly as it is today (`provider.needsWorkspace` false).
- Step ids of the plan block and the human block must not change: a run parked on them must still resume.
- Each task ends with `npm run typecheck && npm run lint && npm test` green.

## Review Focus

Inputs the spec implies and a person will hit; each is pinned by a test in the task named.

1. A reviewer cites a file that does not exist, a line past the end, or a path outside the working copy (`../../etc/passwd`) → refuted with a plain reason, never opened. (Task 3)
2. A verifier's reproduction that fails for the wrong reason (syntax error, missing tool) → not counted as reproduced; and one whose files try to escape the throwaway copy → refused. (Task 5)
3. The person answers a question from another computer, twice, or after the run was cancelled → recorded once, delivered once, a late answer is refused with a plain sentence. (Task 6)
4. A "low" fix that edits a core or sensitive path → held, the person is asked, "undo" restores the copy exactly, including removing files the fix added. (Task 8)
5. A project with no test runner at all → findings end `unbacked`, the run still reaches the human check, and the window says they were not checked. (Tasks 7, 10)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` | `project_notes` gains `number`, `kind`, `paths`, `outcome`, `reason`; new `findings`, `questions` tables |
| `src/engine/register.ts` (new) | The numbered register: add, list, standing entries, core areas, core candidates |
| `src/engine/memory.ts` | Keeps its API; rules become `kind: 'rule'` register entries; `giveRules` → `giveStanding` |
| `src/engine/review.ts` | Finding shape with type / severity / affects / decisions; focuses; depth by risk |
| `src/engine/findings.ts` (new) | Cite check, duplicates, ordering, risk dial (pure) + the findings rows |
| `src/engine/repro.ts` (new) | A reproduction: parse, store apart, run on a throwaway copy, judge |
| `src/engine/tree-snapshot.ts` (new) | Snapshot / restore / diff of a working copy without touching its index |
| `src/engine/questions.ts` (new) | A question with options: ask, answer, read the answer, turn it into a decision |
| `src/engine/inngest/review-stage.ts` (new) | The stage's steps, called from `orchestrateRun` |
| `src/engine/inngest/execute-run.ts` | Calls the stage for a real provider; `sumUpReviews`, `assessGate` read findings |
| `src/providers/types.ts`, `src/providers/claude.ts` | Reviewer context and focus; verifier and fixer runs |
| `src/app/api/runs/[runId]/questions/[questionId]/route.ts` (new) | The person's answer |
| `src/app/api/runs/[runId]/findings/route.ts` (new) | Findings and open question for the UI |
| `src/app/api/projects/[id]/notes/…` | Register kinds and core areas |
| `src/ui/canvas/QuestionPanel.tsx` (new), `FindingsList.tsx` (new) | The question; the findings in the human check |
| `src/ui/canvas/BlockCard.tsx`, `GatePanel.tsx`, `ProjectMemory.tsx`, `Canvas.tsx` | Wiring |

---

## Phase A — register, focused reviewers, app-level checks

### Task 1: The numbered register

**Files:**
- Modify: `src/db/schema.ts` (`projectNotes`), generated migration in `drizzle-pg/`
- Create: `src/engine/register.ts`
- Modify: `src/engine/memory.ts`, `src/engine/inngest/execute-run.ts` (the `memory` step), `src/providers/types.ts`
- Test: `tests/engine/register.test.ts`, extend `tests/engine/memory.test.ts`

**Interfaces — Produces:**
```ts
export type EntryKind = 'rule' | 'decision' | 'core' | 'finding'
export type EntryOutcome = 'done' | 'asked_yes' | 'asked_no' | 'discarded' | 'unchecked' | 'open'
export type Entry = { id: string; number: number; kind: EntryKind; text: string; paths: string[]; source: string; runId: string | null; enabled: boolean; outcome: EntryOutcome | null; reason: string | null; createdAt: string }
export type Standing = { number: number; kind: 'rule' | 'decision' | 'core'; text: string; paths: string[] }
export const label = (n: number): string            // 7 -> "D-07"
export async function addEntry(projectId: string, e: { kind: EntryKind; text: string; paths?: string[]; source: string; runId?: string | null; outcome?: EntryOutcome; reason?: string }, h?: DbHandle): Promise<Entry | null>
export async function listRegister(projectId: string, h?: DbHandle): Promise<Entry[]>          // by number
export async function standingFor(projectId: string, h?: DbHandle): Promise<Standing[]>        // enabled rule|decision|core
export async function corePaths(projectId: string, h?: DbHandle): Promise<string[]>            // patterns of enabled core entries
export function coreCandidates(files: readonly string[]): { area: string; paths: string[] }[]  // from risk.ts SENSITIVE
export function touchesCore(path: string, patterns: readonly string[]): boolean
export async function giveStanding(runId: string): Promise<Standing[]>                         // replaces giveRules
```
`AgentExecutionInput` gains `standing?: Standing[]` (keep `notes` filled with the rule texts so the builder prompt is unchanged).

- [ ] **Step 1: Write the failing tests** in `tests/engine/register.test.ts`:
  - `numbers are per project, start at 1 and are never reused`: add three, delete the second, add one → numbers `[1, 3, 4]`.
  - `two entries added at once get different numbers`: `Promise.all` of 5 `addEntry` → 5 distinct numbers.
  - `existing rules are numbered by the migration in the order they were written` (insert rows with `number` null through raw SQL, run the back-fill function `numberUnnumbered(projectId)`, expect 1..n by `createdAt`).
  - `standingFor leaves out finding lines and switched-off entries`.
  - `label(7) === 'D-07'`, `label(123) === 'D-123'`.
  - `coreCandidates(['src/app/api/pay/route.ts','src/lib/auth.ts','README.md'])` returns the payments/server and sign-in areas with their files and nothing for the README.
  - `touchesCore('src/billing/x.ts', ['src/billing/'])` true; `touchesCore('src/billing2/x.ts', ['src/billing/'])` false; a pattern without a trailing slash matches that exact file only.
  - `giveStanding records once per run`: add an entry after the first call → the second call returns the first result (extend the existing `giveRules` test).
- [ ] **Step 2:** `npx vitest run tests/engine/register.test.ts` → FAIL (module not found).
- [ ] **Step 3: Schema.** `project_notes`: `number integer` (nullable in the column, unique index on `(project_id, number)`), `kind text not null default 'rule'`, `paths text` (JSON array), `outcome text`, `reason text`. Run `npm run db:generate`. Append to the generated SQL a back-fill that numbers existing rows per project by `created_at` (`row_number() over (partition by project_id order by created_at)`).
- [ ] **Step 4: Implement `register.ts`.** Number allocation: inside a transaction, `select id from projects where id = $1 for update`, then `max(number) + 1`. `runs.memoryJson` now stores `Standing[]`; read tolerantly (an old `string[]` becomes rules numbered 0, which `label` never shows). Export `SENSITIVE` from `risk.ts` for `coreCandidates`.
- [ ] **Step 5: `memory.ts`.** `addNote` delegates to `addEntry({ kind: 'rule' })`; `listNotes`, `rulesFor` return only `kind: 'rule'`; `MAX_GIVEN` applies to rules only — decisions and core areas are always given. `giveRules` is replaced by `giveStanding` in the executor's `memory` step (same step id); `prepared.notes` = texts of the rules, `prepared.standing` = all.
- [ ] **Step 6:** run the full check; expect PASS.
- [ ] **Step 7: Commit** — `The project's rules are numbered, and can be decisions or core areas`.

### Task 2: Findings that say what kind they are, and reviewers with a focus

**Files:**
- Modify: `src/engine/review.ts`, `src/providers/types.ts`, `src/providers/claude.ts` (`runReviewer`), `src/ui/strings.ts`
- Test: `tests/engine/review.test.ts`, `tests/providers/claude.test.ts`

**Interfaces — Produces:**
```ts
export type Focus = 'logic' | 'security' | 'effects'
export const FOCUSES: readonly Focus[] = ['logic', 'security', 'effects']
export type FindingType = 'logic' | 'security' | 'effect'
export type Severity = 'high' | 'medium' | 'low'
export type Finding = { type: FindingType; file?: string; line?: number; problem: string; severity: Severity; affects: string[]; decisions: number[] }
export function focusesFor(risk: 'low' | 'high'): Focus[]   // low -> ['logic']; high -> all three
```
`AgentExecutionInput` gains `focus?: Focus`, `builderSummary?: string`, `reviewSince?: string` (a tree id: review only what changed since it). `AgentEvent` `done.review` keeps its shape with the richer `Finding`.

- [ ] **Step 1: Failing tests.**
  - `parseReview` reads `{"verdict":"changes","findings":[{"type":"security","file":"a.ts","line":3,"problem":"x","severity":"high","affects":["panel"],"decisions":[7]}]}` into exactly that finding.
  - A finding with no `type` defaults to `logic`; no or unknown `severity` defaults to `medium`; `decisions` keeps only positive integers; `affects` is capped at 5 strings of 80 characters. (Old-shape answers still parse.)
  - `focusesFor('low')` → `['logic']`; `focusesFor('high')` → `['logic','security','effects']`.
  - In `claude.test.ts`: the reviewer prompt for `focus: 'effects'` contains the request, every job title of `input.jobs`, the builder's summary, each standing entry as `D-07: text`, and the sentence telling it to open the files that use what was changed; with `reviewSince: 'abc123'` it says `git diff abc123` instead of the base commit.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `strings.providers.claude.reviewPrompt` takes `{ request, baseCommit, focus, jobs, builderSummary, standing, since }`; one focus paragraph per `Focus` in `strings.review.focus`. The JSON form asked for gains `type`, `severity`, `affects`, `decisions`. Keep "Only report real problems… not style preferences."
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Commit** — `A reviewer has one thing to look for, and is told what was agreed`.

### Task 3: Checking findings without a model, and the findings rows

**Files:**
- Modify: `src/db/schema.ts` (new `findings` table) + generated migration
- Create: `src/engine/findings.ts`
- Test: `tests/engine/findings.test.ts`

**Interfaces — Produces:**
```ts
export type FindingState = 'reported' | 'refuted' | 'unbacked' | 'confirmed' | 'asked' | 'corrected' | 'fixed_unchecked' | 'discarded' | 'open'
export type FindingRow = Finding & { id: string; runId: string; projectId: string; round: number; reporters: Focus[]; count: number; state: FindingState; reason: string | null; repro: Repro | null; evidence: ReproRun | null; entryNumber: number | null }
export function citeCheck(workdir: string, f: Finding): { ok: true } | { ok: false; reason: string }
export function mergeDuplicates(found: { focus: Focus; finding: Finding }[]): { finding: Finding; reporters: Focus[]; count: number }[]
export function bySeverity<T extends { severity: Severity }>(items: T[]): T[]          // high, medium, low; stable
export function riskOf(f: Finding, ctx: { corePaths: string[]; unknown?: boolean }): { level: 'low' | 'high'; reasons: string[] }
export async function recordFindings(runId: string, round: number, merged: ReturnType<typeof mergeDuplicates>, workdir: string): Promise<FindingRow[]>
export async function setFinding(id: string, change: Partial<Pick<FindingRow, 'state' | 'reason' | 'repro' | 'evidence' | 'entryNumber'>>): Promise<void>
export async function findingsOf(runId: string): Promise<FindingRow[]>
export const DUPLICATE_WINDOW = 3   // lines
```
`Repro` and `ReproRun` come from Task 5; until then declare them in `findings.ts` as the types Task 5 will export and re-export from there.

`findings` table columns: `id`, `project_id`, `run_id` (index), `round`, `type`, `file`, `line`, `problem`, `severity`, `affects_json`, `decisions_json`, `reporters_json`, `count`, `state`, `reason`, `repro_json`, `evidence_json`, `entry_number`, `created_at`, `updated_at`.

- [ ] **Step 1: Failing tests** (use a temp git repo, as `tests/engine/worktree.test.ts` does):
  - `citeCheck`: existing file and line in range → ok; missing file → `strings.findings.noSuchFile`; line 999 of a 10-line file → `strings.findings.noSuchLine`; `file: '../outside.ts'` and an absolute path → `strings.findings.outsideCopy`, and nothing outside the copy is read; a finding with no file → ok (nothing to refute).
  - `mergeDuplicates`: same type, same file, lines 40 and 42 from two reviewers → one finding, `count: 2`, `reporters: ['logic','security']`, keeping the higher severity and the longer problem text; same file, lines 40 and 60 → two; same line, different type → two.
  - `bySeverity` keeps the reported order within one severity.
  - `riskOf`: file under a core pattern → high with `strings.findings.risk.core`; path matching `risk.ts` SENSITIVE → high; `decisions: [7]` → high with `strings.findings.risk.decision('D-07')`; `type: 'security'` and `severity: 'high'` → high; a typo in `README.md` → low; `unknown: true` → high.
  - `recordFindings` writes refuted rows with their reason and `reported` rows for the rest, and appends one `node.findings_checked` event with `{ reported, refuted, merged }` counts.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Add `node.findings_checked`, `node.finding_resolved`, `node.question_asked`, `node.question_answered` to `NodeEventType` in `events.ts`. `citeCheck` resolves the path and requires it to stay inside `workdir` before any read.
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Commit** — `What a reviewer reports is checked against the code before anyone acts on it`.

### Task 4: The Review block runs its reviewers and checks what they found

**Files:**
- Create: `src/engine/inngest/review-stage.ts`
- Modify: `src/engine/inngest/execute-run.ts` (the `else` branch for `review`, `sumUpReviews`, `testFactsOf.reviewOpen`), `src/ui/strings.ts`
- Test: `tests/engine/review-stage.test.ts`, existing `tests/engine/execute-run.test.ts` must stay green

**Interfaces:**
- Consumes: `focusesFor`, `mergeDuplicates`, `recordFindings`, `bySeverity`, `findingsOf`, `Standing`.
- Produces:
```ts
export type StageResult = { outcome: Outcome['outcome']; sendBack: FindingRow[] }
export async function runReviewStage(ctx: { runId: string; plan: Plan; block: PlannedBlock; step: StepApi; id: (name: string) => string; deps: ExecutorDeps; workspace: Workspace; round: number; reviewSince: string | null }): Promise<StageResult>
```
At the end of this task `sendBack` is every finding that survived the cite check; `orchestrateRun` sends them to the builder with the existing `reopenForRevision` loop (unchanged bounds). Phase B replaces what happens to `sendBack`.

- [ ] **Step 1: Failing tests** with a fake provider that answers per `input.focus`:
  - A change that measures high risk runs three reviewer steps with step ids `review-<blockId>-logic|security|effects`; one that measures low runs only `logic`, and the node's steps include `strings.review.depth.one`.
  - Two reviewers report the same line → the builder's revision note lists it once.
  - A finding citing a missing file never reaches the builder and is in `findingsOf` as `refuted`.
  - All findings refuted → the block passes with `strings.review.noProblemsLeft`, and no round is reopened.
  - A reviewer that changes a file fails the block (existing rule), and no finding of any reviewer is used.
  - The demo provider's run produces exactly the events it produced before (snapshot the event types of an existing demo test).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** One node, three provider calls inside it: extend `runProviderNode` (or add a sibling) so a node can be opened once and closed once around several `step.run`s; each reviewer appends its own `node.reviewed` event with `focus`. Risk for the depth rule: `assessRisk(workdir, baseCommit, await testFactsOf(runId))`. The builder's summary for the reviewers is the build node's stored summary.
- [ ] **Step 4: `sumUpReviews`** composes from `findingsOf(runId)`: `strings.review.approve.summary({ found, fixed, discarded, needsYou })` — e.g. "3 problems found. 2 fixed, 1 needs you." `reviewOpen` = any finding in state `open`.
- [ ] **Step 5:** full check → PASS. Start `npm run dev`, run one real task on the `test-factory-ai` project, and confirm on the Review card: one card, a line per reviewer, plain words.
- [ ] **Step 6: Commit** — `Review is three readers on anything but a small change, and their findings are checked first`.

---

## Phase B — reproduce, ask, fix one at a time

### Task 5: A reproduction the app runs itself

**Files:**
- Create: `src/engine/repro.ts`
- Modify: `src/providers/types.ts`, `src/providers/claude.ts` (new `runVerifier`), `src/ui/strings.ts`
- Test: `tests/engine/repro.test.ts`, `tests/providers/claude.test.ts`

**Interfaces — Produces:**
```ts
export type Repro = { command: string; marker: string; files: { path: string; content: string }[] }
export type ReproRun = { exitCode: number | null; markerSeen: boolean; outputTail: string; at: string }
export const MAX_REPRO_FILES = 5; export const MAX_REPRO_BYTES = 64 * 1024; export const REPRO_TIMEOUT_MS = 120_000
export function parseRepro(text: string, readFile: (path: string) => string | null): Repro | null
export function safeReproPath(path: string): boolean                       // relative, no "..", not under .git
export async function makeCopy(workdir: string): Promise<string>           // throwaway copy; caller removes it
export async function runRepro(repro: Repro, workdir: string, signal: AbortSignal): Promise<ReproRun>
export const reproduced = (r: ReproRun): boolean => r.exitCode !== 0 && r.exitCode !== null && r.markerSeen
export const corrected = (r: ReproRun): boolean => r.exitCode === 0
```
`AgentExecutionInput` gains `role?: 'verifier' | 'fixer'` and `finding?: { type: FindingType; file?: string; line?: number; problem: string }`, `repro?: Repro`. `AgentEvent` `done` gains `repro?: Repro | null` and `refuted?: { why: string }` (the verifier showed the cited code does not do what the finding says; read from `{"reproduced":false,"refuted":true,"why":"…"}`).

- [ ] **Step 1: Failing tests.**
  - `runRepro` on a temp repo: a script that prints `MARK-1` and exits 1 → `reproduced` true; exits 1 without the marker (a syntax error) → false; exits 0 → `corrected` true.
  - The working copy is byte-for-byte unchanged after `runRepro` (compare `git status --porcelain` and a file hash), and the throwaway copy is gone.
  - `safeReproPath('../x')`, `('/etc/x')`, `('.git/hooks/pre-commit')` → false; `('tests/repro.test.ts')` → true. `parseRepro` returns null when any file fails it, when there are more than `MAX_REPRO_FILES`, when `command` or `marker` is empty, or when a file is over `MAX_REPRO_BYTES`.
  - A command that never ends is stopped at the timeout and counts as not reproduced.
  - `claude.test.ts`: `role: 'verifier'` builds a prompt that says to assume the finding is false, names the file and line, and asks for `{"reproduced":true|false,"command":"…","marker":"…","files":["path"]}`; it runs with write permission in `input.workdir` (the copy); when the answer says `reproduced: false` the event carries `repro: null`; with `"refuted":true,"why":"x"` it also carries `refuted: { why: 'x' }`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `makeCopy` uses `cloneTree` from `base.ts` into `.factory/verify/<ulid>`. `runRepro` makes a fresh copy, writes the repro files into it, runs the command with `runTestCommand`, removes the copy in `finally`. The verifier's file contents are read from its copy by the provider and carried in `repro.files`; nothing is written to the task's working copy.
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Commit** — `A problem counts as confirmed only when the app reproduced it itself`.

### Task 6: A question with options

**Files:**
- Modify: `src/db/schema.ts` (new `questions` table) + migration, `src/engine/inngest/client.ts` (new `QUESTION_ANSWERED`), `src/engine/relay.ts`
- Create: `src/engine/questions.ts`, `src/app/api/runs/[runId]/questions/[questionId]/route.ts`
- Test: `tests/engine/questions.test.ts`

**Interfaces — Produces:**
```ts
export type Option = { id: string; label: string; means: string }
export type Question = { id: string; runId: string; nodeRunId: string; findingId: string | null; kind: 'finding' | 'fix_held'; text: string; why: string; options: Option[]; recommended: string | null; touches: number[]; state: 'open' | 'answered'; answerOption: string | null; answerText: string | null; actor: string | null; answeredAt: string | null }
export const LEAVE = 'leave'; export const OTHER = 'other'
export async function askPerson(runId: string, nodeRunId: string, q: Pick<Question, 'findingId' | 'kind' | 'text' | 'why' | 'options' | 'recommended' | 'touches'>): Promise<Question>
export async function answerQuestion(questionId: string, a: { option: string; text?: string }, deps: { send: Send; actor?: () => string }): Promise<Question>   // throws QuestionError(status 404|409)
export async function openQuestion(runId: string): Promise<Question | null>
export async function takeAnswer(questionId: string): Promise<Question | null>   // null until answered
export function decisionText(q: Question): string   // "<question> — <chosen option label>" (+ the person's words)
```
`askPerson` moves the run and the node to `waiting_approval` exactly as `parkHumanNode` does and appends `node.question_asked`. `answerQuestion` records, moves the run back to `running`, appends `node.question_answered`, adds a register entry `kind: 'decision'` with `decisionText`, then sends `QUESTION_ANSWERED { runId, questionId }` when the run is this computer's.

- [ ] **Step 1: Failing tests.**
  - Asking parks the run: status `waiting_approval`, last event `node.question_asked`.
  - Answering with a listed option records actor and time, resumes the run, and adds exactly one `decision` entry whose text contains the question and the option's label.
  - `option: 'other'` requires non-empty `text` (else 409 with `strings.question.needWords`); an option id that is not in the list → 409.
  - Answering twice → the second is refused (409, `strings.question.alreadyAnswered`) and no second register entry appears.
  - Answering after the run was cancelled → 409 `strings.question.notWaiting`.
  - An answer recorded for a run of another computer is not sent, and `relayTick` delivers it once (extend the relay to claim undelivered answers the same way it claims approvals).
  - The route refuses a request without the app's own page headers (`requireOwnPage`), like the decision route.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**, following `recordDecision` / `decideGate` in `approvals.ts` and the plan-decision delivery in `relay.ts`. Every question carries the `LEAVE` option last and allows `OTHER`.
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Commit** — `A decision that is the person's reaches them as a question with options`.

### Task 7: Verify each finding, then fix it or ask

**Files:**
- Modify: `src/engine/inngest/review-stage.ts`, `src/engine/inngest/execute-run.ts`, `src/ui/strings.ts`
- Test: `tests/engine/review-stage.test.ts`

**Interfaces:**
- Consumes: `runRepro`, `reproduced`, `makeCopy`, `riskOf`, `corePaths`, `askPerson`, `takeAnswer`, `setFinding`, `addEntry`.
- Produces: `runReviewStage` now returns `{ outcome, fixed: boolean, fixesSince: string | null }`; it no longer returns findings for `reopenForRevision`.

Per finding that passed the cite check, in severity order, each its own durable step:
1. `verify-<findingId>`: copy → verifier → `runRepro` → `confirmed` (reproduced) / `unbacked` (verifier could not, or the app's run did not reproduce) / `refuted` (verifier answered that the cited code does not do what the finding says — read from `{"reproduced":false,"refuted":true,"why":"…"}`).
2. Route: `unbacked` and severity not high → `discarded`, reason `strings.findings.notReproduced`. `confirmed` and `riskOf` low → fix (Task 8). `confirmed` high, or `unbacked` with severity high → `askPerson` with options built by `strings.question.forFinding(row)`: "Fix it" (recommended), "Leave it as it is"; the run parks with the same wait pattern as the human block (`waitForEvent(QUESTION_ANSWERED)` then `takeAnswer`, bounded by `MAX_IGNORED_DECISIONS`).
3. Every ending writes a register line (`kind: 'finding'`, outcome, reason, `runId`) and `node.finding_resolved`.

- [ ] **Step 1: Failing tests** (fake provider scripted per role; fake `runRepro` injected through `ExecutorDeps`):
  - A reproduced low finding goes to the fixer; nothing is asked.
  - A reproduced finding in a core path parks the run with one open question whose `touches` are the finding's decisions; answering "leave" ends it `discarded` with the person's reason and adds a `decision` entry and a `finding` line.
  - A project with no way to reproduce (`runRepro` reports exit null) → medium finding `discarded` with `strings.findings.notReproduced`; high finding asks.
  - The verifier says refuted → `refuted`, the builder never sees it.
  - The wait expiring leaves the run waiting and resolves nothing.
  - More than `MAX_FINDINGS` findings: only the 10 most severe are verified; the rest are `discarded` with `strings.findings.tooMany` and listed as pending.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Add `runRepro?` and `makeCopy?` to `ExecutorDeps` for the tests.
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Commit** — `Small problems are fixed; ones that touch what matters are asked about first`.

### Task 8: One fix at a time, behind a snapshot

**Files:**
- Create: `src/engine/tree-snapshot.ts`
- Modify: `src/providers/claude.ts` (fixer prompt), `src/engine/inngest/review-stage.ts`, `src/ui/strings.ts`
- Test: `tests/engine/tree-snapshot.test.ts`, `tests/engine/review-stage.test.ts`

**Interfaces — Produces:**
```ts
export function snapshotTree(workdir: string): string                       // a git tree id of tracked + untracked files; the real index is not touched
export function restoreTree(workdir: string, tree: string): void             // contents equal the snapshot; files added since are removed
export function changedSince(workdir: string, tree: string): string[]
export const MAX_FIX_ATTEMPTS = 2
```

Fix loop for one finding: `snapshotTree` → fixer (`role: 'fixer'`, prompt `strings.providers.claude.fixPrompt(request, finding, repro)`: fix this one problem, change nothing else, here is the command that shows it) → `changedSince`. If the finding was low and any changed path `touchesCore` or matches `SENSITIVE` and was not already changed by the task before the fix → `askPerson` kind `fix_held` with "Keep the fix", "Undo it" (recommended), other; "Undo" → `restoreTree`, finding `discarded` with the person's reason. Otherwise `runRepro`: `corrected` → state `corrected`; not → retry up to `MAX_FIX_ATTEMPTS`, then `open`. A finding with no repro (unbacked, person chose to fix) → `fixed_unchecked`.

- [ ] **Step 1: Failing tests.**
  - `snapshotTree` then edit a tracked file, add an untracked file, delete a file → `changedSince` lists the three; `restoreTree` puts all three back as they were; `git status --porcelain` and the staged index are the same as before the snapshot.
  - A fix that makes the reproduction pass → `corrected`, with the `ReproRun` stored as evidence.
  - A fix that leaves it failing twice → `open`, and the Approve summary counts it under "needs you".
  - A low finding whose fix edits `src/billing/charge.ts` (a core path) parks the run on a `fix_held` question; "Undo it" restores the file and removes a file the fix added.
  - A fix in a core path that the task had already changed before the fix does not ask again.
  - Fixes run in severity order, one provider call per finding.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `snapshotTree` uses a temporary index file (`GIT_INDEX_FILE`) with `git add -A` and `git write-tree`.
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Commit** — `Each fix is made on its own, checked, and can be undone`.

### Task 9: After the fixes, the checks and one more review

**Files:**
- Modify: `src/engine/inngest/execute-run.ts` (the round loop), `src/engine/inngest/review-stage.ts`
- Test: `tests/engine/review-stage.test.ts`, `tests/engine/execute-run.test.ts`

- [ ] **Step 1: Failing tests.**
  - When the stage fixed something and `reviewRounds < MAX_REVIEW_ROUNDS`: the Tests-kind blocks and the Review block are reopened for the next round (not Build), and the next round's reviewers get `reviewSince` = the tree before the first fix.
  - That second review uses the depth rule on what the fixes changed.
  - After two rounds nothing is reopened; remaining findings are `open` and the run goes on to the human check.
  - When nothing was fixed (all discarded or refuted), no round is reopened.
  - A round reopened by the person's "ask for changes" still starts at Build, as today.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** with the existing `reopenForRevision(runId, blocks, next, note, 'reviewer')`, passing the blocks from the first enabled Tests-kind block to the Review block; `strings.run.reopenedAfterFixes(round)` as the note. Remove the old `result.review?.verdict === 'changes'` branch for real providers; keep it for the demo.
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Commit** — `After fixes the checks run again and the change is read once more`.

### Task 10: The screen

**Files:**
- Create: `src/app/api/runs/[runId]/findings/route.ts`, `src/ui/canvas/QuestionPanel.tsx`, `src/ui/canvas/FindingsList.tsx`
- Modify: `src/ui/canvas/Canvas.tsx`, `BlockCard.tsx`, `GatePanel.tsx`, `ProjectMemory.tsx`, `src/app/api/projects/[id]/notes/route.ts` and `[noteId]/route.ts`, `src/ui/strings.ts`
- Test: `tests/ui/question-panel.test.tsx`, `tests/ui/findings-list.test.tsx`, extend `tests/ui/BlockCard.test.tsx`

**Interfaces:**
- Consumes: `GET /api/runs/[runId]/findings` → `{ findings: FindingView[]; question: Question | null }` where `FindingView = { id, title, type, state, how: 'checked' | 'ai' | 'not_checked', detail: { where, problem, command, outputTail, reason } }`.
- `QuestionPanel` props: `{ question: Question; onAnswer(option: string, text?: string): Promise<void> }`. `FindingsList` props: `{ findings: FindingView[] }`.

Rules from §10, each a test:
- [ ] **Step 1: Failing tests.**
  - The Review card shows one line per reviewer that ran and one summary sentence; no file path and no `D-` number is in its text.
  - `QuestionPanel` renders the sentence, each option with its "what it means" line, a "Recommended" mark on the recommended one, and a box for the person's own words; the buttons are disabled until an option or words are chosen; a click calls `onAnswer` once.
  - `FindingsList` groups as "Fixed", "Needs you", "Set aside", shows for each how it ended in plain words, and marks each as "The app checked it", "AI says so" or "Not checked" — three visibly different marks (assert distinct `data-state`).
  - File, line, command and output appear only after "See details" is opened.
  - With no findings the list renders `strings.findings.none` and no empty headings.
  - `ProjectMemory` shows each entry's number, lets the person add a core area, and lists `coreCandidates` as suggestions that become core only on confirm.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `QuestionPanel` appears in the same place and frame as the plan check and the human check (`Canvas.tsx`, bottom right), reusing `GatePanel`'s layout pieces. `FindingsList` is a section of `GatePanel`, under what is being decided. Follow the frontend-design skill for the visual pass; keep the existing dark theme tokens (`src/ui/theme.ts`).
- [ ] **Step 4:** full check → PASS.
- [ ] **Step 5: Look at it.** With `npm run dev`, on `test-factory-ai`: (a) mark `src/app/` as a core area, (b) run a task that changes `src/app/page.tsx`, (c) follow it to a question and answer it, (d) open the human check. Take a screenshot of the Review card, the question and the findings list, at desktop and at 390px wide. Fix anything that needs explaining.
- [ ] **Step 6: Commit** — `Problems found, how each ended, and the question that is yours, in plain words`.

---

## Self-review notes

- Spec §5.1 → Task 1 · §5.2 → Tasks 2, 4 · §5.3 → Tasks 3, 5, 7 · §3.1 and §5.4 → Tasks 6, 7, 8 · §5.5 → Tasks 7, 8, 9 · §6.4 and §10 (Piece 1's share) → Task 10.
- Not in this plan, by the spec's own order: criteria in four parts and per-job building (Piece 2), the security and requested-behaviour controls (Piece 3), questions raised by the planner or the builder mid-build (they arrive with Piece 2; Task 6's mechanism is built to carry them).
- Running reviewers at the same time is left out on purpose (spec §5.2): they run one after another.

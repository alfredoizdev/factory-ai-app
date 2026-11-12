# Ask Me Only About What Matters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A simple change goes from the request to an open pull request without the person; a plan or a change that touches what matters stops for them, says why in one sentence, and tells them through the tab title and a browser notification.

**Architecture:** The project switch becomes a three-valued *ask mode* (`what_matters`, `everything`, `small_changes`), read once per run with a per-task `stop_for_me` flag. The planner also says which files or folders each job expects to change and may raise one question. A pure function (`measurePlan`) decides from that list whether the plan is simple. The executor then starts Build on its own, asks the planner's question through Piece 1's question window, or stops as it does today. The finished change is still measured by `classifyChange`, which now also stops for decisions that name paths. That measurement is the backstop. After the human check passes (on its own, or by the person's yes in `what_matters` mode), three new durable steps after `finish` reuse `keepOnBranch`, `pushBranch` and `openPullRequest`. Every failure there ends softly with a sentence on the card. The screen gets a mode choice, a checkbox in the composer, reasons one click away, a tab title, notifications and marks in the task list.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Drizzle on Postgres (PGlite in tests), Inngest steps, the `claude` CLI adapter, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-12-ask-only-critical-design.md`. Every section maps to a task (see the coverage table at the end). §7 is settled and not reopened. Each §6 item is decided below, under "Decisions this plan makes".

## Global Constraints

- Develop and verify on the local test database. Schema changes: edit `src/db/schema.ts` (and `src/db/sqlite-schema.ts` to match), run `npm run db:generate`, and commit the one generated file `drizzle-pg/0007_*.sql` with its `meta/`. It is additive only. Never run `npm run db:migrate:neon`: the owner migrates Neon.
- Tests use PGlite through `migrateDb()`. **Projects in tests are made the way the app makes them:** `createProject({ path, name, testCommand, checks: [] })` on a real `git init` folder with one commit, or a `projects` row plus `setLocal(projectId, { repoPath })`. `projects.repo_path` stays NULL. Folders are read with `projectHere(projectId)` only, never `projects.repoPath`.
- **Prompt and parser contract:** every field the planner is asked for is pinned by a test on the prompt side (the words asked for are in `planPrompt`) and on the parser side (that exact form parses). It is also tried once with the real `claude` CLI through `claudeProvider.execute`, with the raw answer recorded (Task 3, Step 6). Parsing uses `jsonObjectsFromEnd` from `src/engine/json-objects.ts`.
- `tests/ui/client-bundle.test.ts` must stay green. No `src/ui` file value-imports server code. Pure helpers the screen needs go in `src/domain/ask-mode.ts` or `src/ui/canvas/attention.ts`, which import only `@/ui/strings` and types.
- Every person-facing word lives in `src/ui/strings.ts`, in plain English. No file path, register number or tool name on a card's first level. Every reason is one click away. No browser `confirm()` or `alert()`. Every changed layout holds at 390 px wide.
- Every side effect happens inside an Inngest step whose id is stable and unique across retries, replans and rounds. Use `pid(...)` inside the plan loop, `id(...)` inside rounds, and fixed ids after `finish`. The database row is the truth; an Inngest event only says "look".
- **Existing step ids do not change.** These keep their ids exactly: `node-${block.id}`, `plan-decided-…`, `read-plan-…`, `confirm-…`, `replan-…`, `assess-…`, `approval-${block.id}`, `read-decision-…`, `decide-…`, and every id in `review-stage.ts`. A run parked under today's code must resume.
- **Stored strings are never reworded later.** These values are compared by code:
  - ask modes: `'what_matters' | 'everything' | 'small_changes'`
  - question kind: `'plan'`
  - event types: `node.plan_measured`, `run.auto_ship`
  - payload keys: `autoStarted`, `autoApproved`, `passedBy`
  - `run.auto_ship` states: `'started' | 'opened' | 'stopped'`
  - `run.auto_ship` steps: `'keep' | 'send' | 'open'`
  - `run.auto_ship` reasons: `'no_connection' | 'failed'`
  - `strings.risk.passedLow`, which is unchanged.
- The limits are unchanged: `MAX_LOW_RISK_FILES = 8`, `MAX_LOW_RISK_LINES = 300`, `SENSITIVE` as it is. New: `MAX_PLAN_ENTRIES = 8`, counted across all jobs.
- Publishing (merge) is never automatic. "Publish it" and "On hold" keep working as they do today.
- The demo provider's path does not change: no measurement, no automatic plan start, no automatic pull request.
- Each task ends with `npm run typecheck && npm run lint && npm test` green. Lint has 0 errors and no more than the 31 existing warnings. Today 86 files and 1193 tests pass; the count only grows.
- Commit messages are one plain sentence in this repo's style (see `git log --oneline -15`) and end with the attribution line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

These are inputs the spec implies and a person will meet. Each is pinned by a test in the task named.

1. **The planner returns a usable plan in a slightly different shape.** Examples: `paths` as one string, `"./src/x.ts"`, a glob `src/**/*.tsx`, `"/abs/path"`, `"../other"`, an empty list, or `paths` on some jobs only. Expected: a string becomes a list of one and `./` is dropped. Anything else that cannot be measured makes the plan **not simple**, with a plain reason, and it is never auto-started. (Tasks 3, 4)
2. **A project made before this change**, with the old switch on, or rows copied from the SQLite backup with `ask_mode` NULL. Expected: it behaves exactly as today. Low-risk changes skip the final check, every plan stops, and nothing is pushed. Settings shows the third option. (Tasks 1, 6, 8)
3. **A run already parked under today's code** (on its plan or at the human check) when the app is updated. Expected: it resumes on the same step ids. Its memoized `Plan` has no `askMode`, so the mode comes from `autoApproveLowRisk` and it is never auto-shipped. (Task 6)
4. **The automatic pull request on a project with no `origin`, no `gh`, `gh` not signed in, or a refused push**, and the person pressing the old button while the steps run. Expected: the change is kept on its branch, the card gives one sentence with the error one click away, the run stays `completed`, nothing retries in a loop, and a second press finds the branch kept and the PR reused. (Task 7)
5. **The planner asks a question, and the person answers with only their own words, or picks "Let the planner choose"**, or the planner asks again on the next plan. Expected: the answer is consumed once. The new plan gets the answer as its note. A second question on the same node is a new row, not the old answered one. At `MAX_REPLANS` the plan stops with the reason instead of asking again. (Task 6)

---

## Decisions this plan makes (spec §6 and gaps found in the code)

1. **Shape of the planner's new fields.**
   - Each job gains `"paths": ["src/ui/Footer.tsx", "src/ui/footer/"]`. A trailing `/` marks a folder.
   - The answer may carry one top-level `"question": {"text": "...", "why": "...", "paths": ["..."], "options": [{"id": "a", "label": "...", "means": "..."}]}`, with 2 to 4 options.
   - Missing `paths` on any job, an empty list across the plan, or any entry that is absolute, has `..`, has a glob character (`*?[]{}`), is empty, or names the whole project (`""`, `"."`, `"/"`) means **not simple**.
   - A `question` that is present but has no text or fewer than 2 usable options is `'unreadable'`, which means **not simple**. Its reason is `strings.plan.reasons.questionUnreadable`.
   - A folder with fewer than two segments (`src/`, `app/`) is "too wide" and means **not simple**.
2. **A plan whose jobs cannot be read at all** keeps today's behaviour: Build works from the request, and the plan does not stop. The spec says "stops, as today", but today it does not stop. The backstop still measures the finished change. This is reported below as a contradiction.
3. **Reusing delivery and ship.**
   - The automatic path calls the same `keepOnBranch`, `pushBranch` and `openPullRequest`.
   - The route's "suggest a branch name and a commit message" lines move into `keepOptionsFor(runId, name)` in `src/engine/delivery-options.ts`. The route and the automatic step both call it.
   - `DeliveryError` and `ShipError` gain an optional `kind: 'no_connection'`, set where they throw `noRemote`, `noGh`, `notLoggedIn` and `notGitHub`.
4. **A pass by the app counts as passing the human check.** Today `delivery.approvedAndFinished` and `startFollowUp` require an `approvals` row, so a change waved through by the old switch can never be kept, sent or continued. This is an existing defect, and the automatic pull request depends on it. The new `humanCheckPassedBy(runId)` accepts that row **or** a `node.completed` event with `autoApproved: true` on a human node.
5. **Where the per-task checkbox is stored:** `runs.stop_for_me boolean not null default false`, set by `createRun`. A follow-up and a picked-up failed task copy the parent's value. The checkbox appears only on the new-task composer, and a follow-up inherits.
6. **Where the ask mode is stored:** `projects.ask_mode text` (nullable).
   - NULL means it is derived from the old boolean: `true` → `small_changes`, `false` → `everything`. This covers existing rows and rows copied from SQLite with no backfill.
   - `createProject` writes `what_matters` unless told otherwise. `setAskMode` writes `ask_mode` and keeps `auto_approve_low_risk = mode !== 'everything'`.
   - An unknown stored value reads as `everything`, the safest choice.
7. **The tab title carries the count, in words:**
   - `"2 waiting for you · AI Factory"`, otherwise `"Ready to publish · AI Factory"`, otherwise `"AI Factory"`.
   - The count is the tasks in the open project's list with status `waiting_approval`. The list is read again whenever the open task's status changes; nothing new polls.
   - A notification fires only for the open task's own moves, and only while `document.hidden`.
   - Permission is asked only from an explicit button.
8. **The planner's question** is asked in every mode. It never skips a stop; it only adds one. When answered, the planner plans again in the same node with a note built from the answer, and the new plan is measured again. The always-added "leave" option is labelled "Let the planner choose".
9. **Decisions get paths from their source**, because today no decision carries paths. Without this, the "decision with paths" rule has nothing to act on.
   - An answer to a finding question records the finding's `file` as the decision's paths.
   - An answer to a planner question records the question's `paths`.
   - Decisions without paths stay words-only. There is no new screen for typing paths onto a decision.
10. **Plan measurement reads the register live** (`standingFor(projectId)`) at measuring time, as `assessGate` reads core areas live. It does not read the copy the task was given at start.
11. **"Stop for me" also turns off the automatic pull request for that task.** The box forces both stops, and after the person's yes the change waits for the existing send button. `shipsOnItsOwn` is false with `stopForMe`. The spec does not say whether a yes on a stop-for-me task sends; this plan reads "stop for me" as "I drive this one".
12. **How a plan entry is matched.** Folder or file overlap with a core or decision pattern counts in both directions (`pathsOverlap`). `SENSITIVE` is tested against the entry text itself.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/ask-mode.ts` (new, client-safe) | `AskMode`, `ASK_MODES`, `askModeOf`, `passesLowRisk`, `shipsOnItsOwn` |
| `src/db/schema.ts`, `src/db/sqlite-schema.ts`, `drizzle-pg/0007_*.sql` | `projects.ask_mode`, `runs.stop_for_me` |
| `src/engine/project-settings.ts`, `src/engine/projects.ts`, `src/app/api/projects/route.ts`, `src/app/api/projects/[id]/route.ts` | The mode: read, set, new-project default |
| `src/engine/run.ts`, `src/engine/follow-up.ts`, `src/app/api/workflows/[id]/runs/route.ts` | `stopForMe` on a run, and inherited |
| `src/engine/passed-check.ts` (new) | `humanCheckPassedBy` |
| `src/engine/delivery.ts`, `src/engine/follow-up.ts` | Eligibility through `humanCheckPassedBy`; `Delivery.passedBy`, `Delivery.autoShip` |
| `src/engine/plan.ts`, `src/providers/claude.ts`, `src/providers/types.ts`, `src/ui/strings.ts` | Planner fields: prompt, parser, done event |
| `scripts/try-planner.ts` (new) | One real-CLI planner run through `claudeProvider.execute`; prints the raw answer and the parse |
| `src/engine/plan-measure.ts` (new) | `measurePlan`, `pathsOverlap`, `MAX_PLAN_ENTRIES` (pure) |
| `src/engine/risk.ts`, `src/engine/questions.ts`, `src/engine/inngest/review-stage.ts` | Decisions with paths: backstop, and paths recorded on answers |
| `src/engine/inngest/execute-run.ts`, `src/engine/inngest/answers.ts` (new), `src/engine/events.ts` | Automatic plan start, planner question, mode-aware gate, automatic ship steps |
| `src/engine/delivery-options.ts` (new), `src/engine/auto-ship.ts` (new), `src/engine/ship.ts`, `src/app/api/runs/[runId]/delivery/route.ts` | Keep, send and open on their own, soft endings |
| `src/ui/canvas/AgentSettings.tsx`, `AddProjectDialog.tsx`, `ProjectMemory.tsx`, `Composer.tsx` / `CanvasScreen.tsx` | Mode choice, decisions limit sentence, "Stop for me on this one" |
| `src/ui/canvas/PlanSection.tsx`, `BlockCard.tsx`, `BlockDetails.tsx`, `src/engine/block-details.ts`, `useRunStream.ts`, `ResultPanel.tsx`, `ShipSection.tsx` | Reasons on the plan, "See the plan", automatic ship sentences |
| `src/ui/canvas/attention.ts` (new), `CanvasScreen.tsx`, `PastTasks.tsx`, `src/engine/run.ts` (`listRuns`) | Tab title, notification, task-list marks |

---

### Task 1: The ask mode and "stop for me", stored

**Files:**
- Create: `src/domain/ask-mode.ts`
- Modify: `src/db/schema.ts`, `src/db/sqlite-schema.ts`, generated `drizzle-pg/0007_*.sql`
- Modify: `src/engine/project-settings.ts`, `src/engine/projects.ts`, `src/engine/run.ts` (`createRun`), `src/engine/follow-up.ts`
- Modify: `src/app/api/projects/route.ts`, `src/app/api/projects/[id]/route.ts`, `src/app/api/workflows/[id]/runs/route.ts`, `src/app/canvas/[workflowId]/page.tsx` (default settings object)
- Test: `tests/domain/ask-mode.test.ts`; extend `tests/engine/project-settings.test.ts`, `tests/engine/projects.test.ts`, `tests/engine/run.test.ts`, `tests/db/pg.test.ts`

**Interfaces — Produces:**
```ts
// src/domain/ask-mode.ts (imports nothing but types)
export type AskMode = 'what_matters' | 'everything' | 'small_changes'
export const ASK_MODES: readonly AskMode[] = ['what_matters', 'everything', 'small_changes']
export function askModeOf(row: { askMode: string | null; autoApproveLowRisk: boolean }): AskMode
/** The final check opens on its own for a low-risk change. */
export function passesLowRisk(mode: AskMode, stopForMe: boolean): boolean   // what_matters|small_changes && !stopForMe
/** Simple plans start on their own, and a passed change is sent and opened as a pull request. */
export function shipsOnItsOwn(mode: AskMode, stopForMe: boolean): boolean   // what_matters && !stopForMe
// src/engine/project-settings.ts
export type ProjectSettings = { /* autoApproveLowRisk removed */ askMode: AskMode; /* rest unchanged */ }
export async function setAskMode(projectId: string, mode: AskMode): Promise<void>  // replaces setAutoApproveLowRisk
// src/engine/projects.ts — createProject input: `askMode?: AskMode` replaces `autoApproveLowRisk?`; default 'what_matters'
// src/engine/run.ts — createRun input gains `stopForMe?: boolean`
```

- [ ] **Step 1: Write the failing tests.**
  - `askModeOf({ askMode: null, autoApproveLowRisk: true })` returns `'small_changes'`. With `false` it returns `'everything'`. `{ askMode: 'what_matters', autoApproveLowRisk: false }` returns `'what_matters'`. `{ askMode: 'nonsense', autoApproveLowRisk: true }` returns `'everything'`.
  - `passesLowRisk`: true for `what_matters` and `small_changes` when `stopForMe` is false. False for `everything`. False for any mode when `stopForMe` is true.
  - `shipsOnItsOwn`: true only for `('what_matters', false)`.
  - `a new project starts on "Ask me only about what matters"`: `createProject` on a real git folder, then `getProjectSettings` gives `askMode` `'what_matters'`.
  - `an existing project with the old switch on keeps "small changes skip my final check"`: insert a `projects` row with `auto_approve_low_risk = true` and `ask_mode` NULL, call `setLocal`, and `getProjectSettings` gives `'small_changes'`.
  - `setAskMode(id, 'everything')` stores `ask_mode = 'everything'` and `auto_approve_low_risk = false`. `setAskMode(id, 'what_matters')` stores `auto_approve_low_risk = true`.
  - `PUT /api/projects/[id]` with `{ askMode: 'what_matters' }` returns settings with that mode. `{ askMode: 'maybe' }` returns 400 with `strings.errors.invalidBody`. The old `autoApproveLowRisk` key is no longer accepted: a body carrying only that key leaves the mode unchanged.
  - `createRun({ ..., stopForMe: true })` makes a row with `stopForMe: true`, and the default is `false`.
  - A follow-up of a parent with `stopForMe: true` has `stopForMe: true`. So does `continueFailed`.
  - `tests/db/pg.test.ts`: a freshly migrated `projects` row reads `askMode: null`, and a `questions` row reads `paths: null`.
- [ ] **Step 2:** Run `npx vitest run tests/domain/ask-mode.test.ts tests/engine/project-settings.test.ts tests/engine/projects.test.ts tests/engine/run.test.ts tests/db/pg.test.ts`. Expected: FAIL, because the module and columns are missing.
- [ ] **Step 3: Schema.** Add three columns:
  - `askMode: text('ask_mode')` (nullable) to `projects`;
  - `stopForMe: boolean('stop_for_me').notNull().default(false)` to `runs`;
  - `paths: text('paths')` (nullable JSON array) to `questions`. Task 6 uses it for the planner question's paths.

  Make the same change in `sqlite-schema.ts`. Run `npm run db:generate` and check that the SQL is only three `ALTER TABLE … ADD COLUMN` statements. This is the plan's only migration.
- [ ] **Step 4: Implement** `ask-mode.ts`, `setAskMode`, and `getProjectSettings` returning `askMode: askModeOf(row)`. In `createProject`, write `askMode: input.askMode ?? 'what_matters'` and `autoApproveLowRisk: mode !== 'everything'`.
  - In the routes, replace `autoApproveLowRisk: z.boolean().optional()` with `askMode: z.enum(['what_matters', 'everything', 'small_changes']).optional()`.
  - The runs route body gains `stopForMe: z.boolean().optional()`, which is passed through. `startFollowUp` and `continueFailed` set `stopForMe: parent.stopForMe` in their existing `update(runs)`.
  - Update the call sites `AddProjectDialog.tsx` and `AgentSettings.tsx` minimally so they type-check: send `askMode` derived from the checkbox. Task 8 replaces those controls.
- [ ] **Step 5:** Run the full check. Expected: PASS.
- [ ] **Step 6: Commit:** `A project chooses when the app stops for the person, new projects start on only what matters, old ones keep what they did, and a task can ask to be stopped`.

### Task 2: A change the app passed counts as passed

**Files:**
- Create: `src/engine/passed-check.ts`
- Modify: `src/engine/delivery.ts` (`approvedAndFinished`, `deliveryState`, `Delivery`), `src/engine/follow-up.ts` (`startFollowUp`)
- Test: `tests/engine/passed-check.test.ts`; extend `tests/engine/delivery.test.ts`, the follow-up tests in `tests/engine/run.test.ts` (or wherever `startFollowUp` is tested today)

**Interfaces — Produces:**
```ts
/** Who opened the human check: the person (an 'approved' approvals row) or the app (node.completed with autoApproved: true on a human node). */
export async function humanCheckPassedBy(runId: string, h?: DbHandle): Promise<'person' | 'app' | null>
// Delivery gains:
passedBy: 'person' | 'app' | null
```

- [ ] **Step 1: Failing tests.**
  - `a run the app passed is eligible to keep`: make a completed run with a worktree, a human node, and a `node.completed` event with `{ autoApproved: true }`, and no approvals row. `deliveryState(runId)` gives `eligible: true` and `passedBy: 'app'`.
  - With an approvals row `decision: 'approved'`, it gives `passedBy: 'person'`.
  - With neither, it gives `eligible: false` and `passedBy: null`.
  - `autoApproved: true` on a **non-human** node does not count.
  - `startFollowUp` on an app-passed completed run creates the follow-up and does not throw `strings.followUp.notEligible`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Find the human node from `nodeRuns` joined with the run's version graph (block kind `human`), as `planWasMade` reads plan blocks. `approvedAndFinished` uses `(await humanCheckPassedBy(runId)) !== null`. `startFollowUp` replaces its approvals query with the same check.
- [ ] **Step 4:** Run the full check. Expected: PASS.
- [ ] **Step 5: Commit:** `A change that passed the human check on its own can be kept, sent and continued like one a person approved`.

### Task 3: The planner says what it expects to change, and may ask one thing

**Files:**
- Modify: `src/engine/plan.ts`, `src/providers/claude.ts` (`runPlanner`, its `cleanJobs`), `src/providers/types.ts` (`AgentEvent` done), `src/engine/inngest/execute-run.ts` (`Done` type only), `src/ui/strings.ts` (`providers.claude.planPrompt`)
- Create: `scripts/try-planner.ts`
- Test: extend `tests/engine/plan.test.ts`, `tests/providers/claude.test.ts`

**Interfaces — Produces:**
```ts
// src/engine/plan.ts
export type Job = { title: string; done: string[]; paths?: string[] }     // absent: the planner gave none
export type PlanOption = { id: string; label: string; means: string }
export type PlanQuestion = { text: string; why: string; paths: string[]; options: PlanOption[] }
export type PlannerAnswer = { jobs: Job[]; question: PlanQuestion | 'unreadable' | null }
export const MAX_PATHS_PER_JOB = 20
export const MAX_PLAN_OPTIONS = 4
export function readPlannerAnswer(text: string): PlannerAnswer | null     // null: no usable jobs
export function parsePlan(text: string): Job[] | null                    // = readPlannerAnswer(text)?.jobs ?? null (kept)
// cleanJobs keeps `paths` when it is an array (strings trimmed, "./" stripped, at most MAX_PATHS_PER_JOB, each clipped to 300)
// or a single string (a list of one); any other value leaves `paths` absent.
// AgentEvent done and Done gain: planQuestion?: PlanQuestion | 'unreadable'
```
Paths are kept as written: not redacted and not lower-cased. They are file names the app compares, as `review.ts` keeps `file`. Question `text`, `why`, `label` and `means` are redacted and clipped (500 / 1000 / 80 / 300). An option id is `[a-z0-9_-]{1,20}`. Ids `other` and `leave` are dropped, and so are duplicates.

- [ ] **Step 1: Failing tests (parser side).**
  - `readPlannerAnswer('…{"jobs":[{"title":"Add footer","done":["shows year"],"paths":["src/ui/Footer.tsx","src/ui/footer/"]}]}')` gives `{ jobs: [{ title: 'Add footer', done: ['shows year'], paths: ['src/ui/Footer.tsx', 'src/ui/footer/'] }], question: null }`.
  - `"paths":"./src/a.ts"` becomes `paths: ['src/a.ts']`. `"paths":[]` stays `paths: []`. Leaving the key out leaves `paths` undefined.
  - A question with `text`, `why`, `paths: ['src/auth/']` and two options parses to that `PlanQuestion`.
  - A question with one option, or with no text, gives `question: 'unreadable'`. Options with id `leave` or `other` are dropped before counting.
  - Code with braces before the object (`renders {sum(2,2)}` then the JSON) still parses, which shows `jsonObjectsFromEnd` is used.
  - `parsePlan` on today's form (no paths) returns the same jobs as before.
  - `decidePlan(runId, { action: 'build', jobs: [{ title: 'x', done: [], paths: ['a.ts'] }] })` records `paths` in `node.planned`. Jobs without `paths` record none.
- [ ] **Step 2: Failing tests (prompt side, `claude.test.ts`).**
  - `planPrompt(...)` contains `'"paths"'` and this sentence verbatim: `'For each job, list in "paths" every file it will change or add, as the project names it (for example src/ui/Footer.tsx). End a folder with / only when the job changes many files inside it.'`
  - It contains this sentence verbatim: `'If something must be decided by the person before the work can be planned (which way sign-in works, what a price is), add "question" with two to four options. Otherwise leave "question" out.'`
  - The JSON form it ends with is exactly `{"jobs":[{"title":"what to do","done":["how to tell it is done"],"paths":["path/to/file.ts"]}],"question":{"text":"what to decide","why":"why it matters","paths":["files it is about"],"options":[{"id":"a","label":"short choice","means":"what happens then"}]}}`.
  - It also contains `'Leave out "question" when nothing needs deciding.'`
  - A fake planner run whose `fullText` is that exact form yields a `done` event with `plan[0].paths` and a `planQuestion` matching the parse. A run with an unreadable question yields `planQuestion: 'unreadable'`.
- [ ] **Step 3:** Run `npx vitest run tests/engine/plan.test.ts tests/providers/claude.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Write `readPlannerAnswer`: take the last object whose `jobs` cleans to a list, and read `question` from **that same object**. Extend `cleanJobs` in both `plan.ts` and the redacting copy in `claude.ts`, which must carry `paths` through unchanged. Update `planPrompt` with the three sentences and the JSON form above; keep the existing lines. `runPlanner` yields `planQuestion` when it is not null.
- [ ] **Step 5:** Run the full check. Expected: PASS.
- [ ] **Step 6: Try it with the real `claude` CLI (required before this task is done).**
  - `scripts/try-planner.ts <repoDir> <request>` builds an `AgentExecutionInput` with `blockKind: 'plan'`, `workdir: repoDir` and `model: 'sonnet'`. It calls `claudeProvider.execute(input, { signal })`, which is the same entry the executor's `runAttempt` uses. It prints the done event's `fullText` raw, then `JSON.stringify(readPlannerAnswer(fullText), null, 2)`.
  - Make a small real repository in the scratchpad: `git init`, then `src/ui/Footer.tsx` (a component), `src/auth/login.ts`, `README.md`, and one commit.
  - Run A: `npx tsx --tsconfig tsconfig.json scripts/try-planner.ts <dir> "Add the current year to the footer"`.
  - Run B: `… "Let people sign in with a username instead of their email"`.
  - Paste both raw answers and both parses into the task's report.
  - **Passed when:** A parses with every job having non-empty `paths` that include `src/ui/Footer.tsx`, and `question` is `null`. B parses with `paths` naming `src/auth/` or `src/auth/login.ts`, or with a readable `question`. A parse of `null`, or jobs without `paths`, is a failure. Fix the prompt (and its pinned test) and run again before committing.
- [ ] **Step 7: Commit:** `The planner says which files each job expects to change and can ask the person one thing first, read from the last object of its answer and tried with the real CLI`.

### Task 4: Measuring a plan

**Files:**
- Create: `src/engine/plan-measure.ts`
- Modify: `src/ui/strings.ts` (`plan.reasons`)
- Test: `tests/engine/plan-measure.test.ts`

**Interfaces:**
- Consumes: `Job`, `PlanQuestion` (Task 3); `SENSITIVE`, `insideCoreArea` (`risk.ts`); `Standing` (`register.ts`).
- Produces:
```ts
export const MAX_PLAN_ENTRIES = 8
export type PlanVerdict = { simple: boolean; reasons: string[]; entries: string[] }   // entries: every path, de-duplicated, in order
/** True when one pattern covers the other: equal, or a folder ("x/") that the other lies inside, either way. */
export function pathsOverlap(a: string, b: string): boolean
export function measurePlan(
  answer: { jobs: readonly Job[]; question: PlanQuestion | 'unreadable' | null },
  register: { core: readonly string[]; decisions: readonly { text: string; paths: readonly string[] }[] },
): PlanVerdict
```
Reasons appear in this order, each at most once per kind (sensitive once per area, decision once per decision):
1. question
2. no paths
3. unmeasurable
4. too wide
5. sensitive
6. core
7. decision
8. too many

When there are none, `reasons` is `[strings.plan.reasons.simple(entries.length)]`.

**Strings added (`strings.plan.reasons`):**
- `asks: 'The planner needs you to decide something.'`
- `questionUnreadable: 'The planner wanted to ask you something, but its question could not be read.'`
- `noPaths: 'The planner did not say which files it expects to change.'`
- `unmeasurable: (p: string) => \`The planner named “${p}” in a way the app cannot measure.\``
- `tooWide: (p: string) => \`“${p}” is too large a part of the project to call simple.\``
- `sensitive: (area: string) => \`It expects to change files that deal with ${area}.\``
- `core: 'It expects to change a part of the project you marked as a core area.'`
- `decision: (text: string) => \`It expects to change files that one of your decisions covers: “${text}”.\``
- `tooMany: (n: number, max: number) => \`It expects to change ${n} files or folders; a simple change is at most ${max}.\``
- `simple: (n: number) => \`It expects to change ${n} ${n === 1 ? 'file or folder' : 'files or folders'}, none of them sensitive, in a core area or covered by a decision of yours.\``

- [ ] **Step 1: Failing tests.**
  - One job with `paths: ['src/ui/Footer.tsx']`, no question, and an empty register gives `{ simple: true, reasons: [strings.plan.reasons.simple(1)], entries: ['src/ui/Footer.tsx'] }`.
  - A job with `paths` undefined gives `simple: false` with `reasons[0] === strings.plan.reasons.noPaths`. So does every job having `paths: []`.
  - **One job that is not simple stops the whole plan:** job 1 is `['src/ui/a.tsx']` and job 2 is `['src/lib/auth/session.ts']`. The result has `simple: false` and includes `strings.plan.reasons.sensitive(strings.risk.areas.auth)`.
  - `['src/app/api/']` gives `sensitive(strings.risk.areas.server)`.
  - Each of `['src/**/*.tsx']`, `['/etc/x']`, `['../x.ts']` and `['.']` gives `unmeasurable(<that entry>)`. `['src/']` gives `tooWide('src/')`.
  - **Folder rule:** core `['src/billing/']` with plan `['src/billing/total.ts']` gives `core`. Core `['src/billing/total.ts']` with plan `['src/billing/']` gives `core`. Core `['src/billing/']` with plan `['src/billing2/x.ts']` is simple.
  - Decision `{ text: 'Prices round down', paths: ['src/pricing/'] }` with plan `['src/pricing/round.ts']` gives `decision('Prices round down')`. A decision with `paths: []` never stops a plan.
  - **8 entries across jobs:** four jobs of two distinct files each is simple (8). Nine distinct files across three jobs gives `tooMany(9, 8)`. The same file named in two jobs counts once.
  - `question` set gives `reasons[0] === asks`. `'unreadable'` gives `reasons[0] === questionUnreadable`.
  - `pathsOverlap('a/', 'a/b.ts')`, `pathsOverlap('a/b.ts', 'a/')` and `pathsOverlap('a/b.ts', 'a/b.ts')` are true. `pathsOverlap('a/b.ts', 'a/c.ts')` and `pathsOverlap('ab/', 'a/')` are false.
- [ ] **Step 2:** Run `npx vitest run tests/engine/plan-measure.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement as pure code with no database access. The unmeasurable pattern is: empty, starts with `/`, contains a `..` segment, contains any of `*?[]{}`, or equals `.` or `./`. Too wide means a folder with fewer than 2 non-empty segments.
- [ ] **Step 4:** Run the full check. Expected: PASS.
- [ ] **Step 5: Commit:** `The app measures a plan from the files it expects to change: a sensitive file, a core area, a decision, too many files or a question stops it`.

### Task 5: Decisions that name paths stop the finished change too (the backstop)

**Files:**
- Modify: `src/engine/risk.ts` (`classifyChange`, `assessRisk`), `src/engine/inngest/execute-run.ts` (`assessGate`), `src/engine/questions.ts` (`answerQuestion` records paths), `src/ui/strings.ts`
- Test: extend `tests/engine/risk.test.ts`, `tests/engine/questions.test.ts`, `tests/engine/execute-run-workspace.test.ts`

**Interfaces:**
- Consumes: `insideCoreArea(file, pattern)` (a changed file is a file, so the core-area rule applies) and `standingFor`.
- Produces:
```ts
export type DecisionPaths = { text: string; paths: readonly string[] }
export function classifyChange(files: readonly ChangedFile[], tests: TestFacts, core?: readonly string[], decisions?: readonly DecisionPaths[]): RiskAssessment
export function assessRisk(workdir: string, baseCommit: string, tests: TestFacts, core?: readonly string[], decisions?: readonly DecisionPaths[]): RiskAssessment
```
In `answerQuestion`, the decision entry gains `paths`. For kind `finding`, that is `[finding.file]` when there is one, and `[]` otherwise. This task adds the finding case. Task 6 adds the planner-question case, which reads `questions.paths`.

**Strings added (`strings.risk`):**
- `onDecision: (path: string, text: string) => \`${path} is covered by your decision “${text}”.\``
- `moreDecisions: (n: number) => \`It also changes files that ${n} more ${n === 1 ? 'decision' : 'decisions'} of yours cover.\``

- [ ] **Step 1: Failing tests.**
  - `classifyChange([{ path: 'src/pricing/round.ts', lines: 3 }], passingTests, [], [{ text: 'Prices round down', paths: ['src/pricing/'] }])` gives `level: 'high'` with reasons containing `strings.risk.onDecision('src/pricing/round.ts', 'Prices round down')`.
  - The same change with `decisions: [{ text: 'x', paths: [] }]` gives `level: 'low'`.
  - Six decisions hit give five `onDecision` reasons plus `moreDecisions(1)`.
  - Existing calls with three arguments behave exactly as before. Every existing `risk.test.ts` case is unchanged.
  - `questions.test.ts`: answering a finding question about `src/pricing/round.ts` with option `leave` and the words `"on purpose"` adds a decision entry with `paths: ['src/pricing/round.ts']`. The same answer without words adds no decision, which is today's rule.
  - `execute-run-workspace.test.ts`: a project (made with `createProject`) has a decision entry with paths `['src/pricing/']`, a run's change touches `src/pricing/round.ts`, and the mode is `what_matters`. The gate parks: `node.assessed.level === 'high'`, and there is no `autoApproved`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Decision reasons come right after core reasons and are capped with `MAX_CORE_REASONS`. `assessGate` reads `standingFor(projectId)` once and passes `core` (kind `core`) and `decisions` (kind `decision` with `paths.length > 0`).
- [ ] **Step 4:** Run the full check. Expected: PASS.
- [ ] **Step 5: Commit:** `A finished change that lands on files one of the person's decisions names needs them, and an answer about a file keeps that file on its decision`.

### Task 6: The executor starts a simple plan on its own, asks the planner's question, and follows the mode

**Files:**
- Create: `src/engine/inngest/answers.ts`
- Modify: `src/engine/inngest/execute-run.ts`, `src/engine/inngest/review-stage.ts` (use `waitForAnswer`, ids unchanged), `src/engine/questions.ts`, `src/engine/events.ts`, `src/ui/strings.ts`
- Test: extend `tests/engine/execute-run-workspace.test.ts`, `tests/engine/questions.test.ts`, `tests/engine/review-stage.test.ts` (unchanged ids still pass)

**Interfaces:**
- Consumes: `askModeOf`, `passesLowRisk`, `shipsOnItsOwn` (Task 1); `readPlannerAnswer`, `PlanQuestion` (Task 3); `measurePlan` (Task 4).
- Produces:
```ts
// Plan (execute-run.ts) gains; autoApproveLowRisk stays for runs already in flight
askMode?: AskMode
stopForMe?: boolean
export function modeOf(plan: Plan): { mode: AskMode; stopForMe: boolean }   // askMode ?? (autoApproveLowRisk ? 'small_changes' : 'everything')
// Outcome['outcome'] gains 'asking'; Outcome gains `jobs?: Job[]` and `question?: PlanQuestion`
// runProviderNode gains a last optional param: planning?: { canAsk: boolean }
// src/engine/inngest/answers.ts
export async function waitForAnswer(step: StepApi, id: (n: string) => string, runId: string, asked: Question, tag: string): Promise<Question | 'parked' | 'cancelled'>
// questions.ts
Question['kind']: 'finding' | 'fix_held' | 'plan'
askPerson(..., q & { paths?: string[] })   // written to questions.paths (Task 1's column) as a JSON array
// events.ts: NodeEventType gains 'node.plan_measured'  payload { blockId, simple, reasons, entries, mode, stopForMe }
```

- [ ] **Step 1: Failing tests (`execute-run-workspace.test.ts`).** Each test uses a project from `createProject` and a fake provider whose planner `done` carries the given `plan` and `planQuestion`.
  - `a simple plan starts on its own in "only what matters"`:
    - The plan node ends `passed` with `node.completed` payload `{ summary: strings.plan.startedOnItsOwn, summarySource: 'system', autoStarted: true }`.
    - `node.plan_measured` has `simple: true`.
    - **No `run.waiting_approval` is written for the plan block.**
    - Build receives `jobs` with their paths.
  - `the same plan stops in "ask me about everything"`: the plan parks as today, and `node.plan_measured` has `simple: true` with `reasons[0] === strings.plan.reasons.everything`.
  - The same plan with `stopForMe: true` parks, with `reasons[0] === strings.plan.reasons.stopForMe`.
  - With `small_changes` it parks, with `reasons[0] === strings.plan.reasons.smallChanges`.
  - `a sensitive plan stops and says why`: paths `['src/auth/login.ts']` park, with `reasons[0] === strings.plan.reasons.sensitive(strings.risk.areas.auth)`.
  - `every new plan is measured again`: plan 1 is sensitive and parks. The person asks for another plan. Plan 2 is simple and starts on its own under `node-plan-plan1`, with ids `measure` and `auto` derived through `pid`.
  - `the planner's question is asked, the answer goes to the next plan`:
    1. The `done` event has `planQuestion`, so the node gets `node.planned` and `node.question_asked` with `kind: 'plan'`, and the run is `waiting_approval`.
    2. `answerQuestion(id, { option: 'a' })` is given, then `QUESTION_ANSWERED` is sent.
    3. The planner runs again with a revision note equal to `strings.plan.answerNote(text, label, null)`.
    4. The second plan (no question, simple) starts on its own.
  - A question on round `k === MAX_REPLANS` is not asked. The plan parks with `reasons[0] === strings.plan.reasons.asks`.
  - `planQuestion: 'unreadable'` parks the plan, with `reasons[0] === strings.plan.reasons.questionUnreadable`.
  - `the final check follows the mode`:
    - A low-risk change with `what_matters` passes with `autoApproved: true`, and so does `small_changes`.
    - With `everything` it parks. With `what_matters` and `stopForMe` it parks.
  - `a run already in flight keeps its old setting`: a memoized `Plan` without `askMode` and with `autoApproveLowRisk: true` gives `modeOf` → `small_changes`.
  - `parked runs resume`: the existing tests that resume on `approval-human` and `plan-decided-plan-0` pass unchanged.
- [ ] **Step 2: Failing tests (`questions.test.ts`).**
  - `askPerson` with kind `'plan'` on a node whose earlier plan question is answered **and consumed** creates a new row and does not return the old one. An unconsumed one is returned as today.
  - `decisionText` for kind `plan`, with option `a` labelled `"Use username"` and words `"keep email for old accounts"`, gives `strings.question.decision({ about: strings.question.about('plan', undefined, 'Which sign-in?'), choice: 'you chose “Use username”', words: 'keep email for old accounts' })`.
  - The register entry made from it has `paths` equal to the question's paths.
- [ ] **Step 3: Implement `questions.ts`.**
  - The kind union gains `'plan'`.
  - The `same` lookup adds `isNull(questions.consumedAt)` when the kind is `'plan'`.
  - `askPerson` writes `JSON.stringify(paths ?? [])` to `questions.paths`. `answerQuestion` reads it for kind `plan` and passes it as the decision's `paths`. Kind `finding` uses the finding's file (Task 5). The existing `touchesJson` and `optionsJson` shapes are not changed.
  - `strings.question.about` gains a third parameter, `planText?: string`. For kind `plan` it returns `` `About the planner's question “${planText}”` ``.
  - `strings.question.chose` for `plan` returns `` `you chose “${label}”` `` from the option's label, so `decisionText` passes the label for kind `plan`.
- [ ] **Step 4: Implement the executor.**
  - `loadPlan` sets `askMode: askModeOf(project)` and `stopForMe: run.stopForMe`.
  - In the plan branch of `runProviderNode`, when `result.plan` is present:
    1. Inside the same transaction, read `standingFor(projectId, tx)` and compute `measurePlan`. Then, if the mode says it may not start on its own, replace `reasons` with the one mode reason in front (`everything`, `smallChanges` or `stopForMe`), keeping the measured ones after it. Record `node.plan_measured`, then `node.planned`.
    2. If there is a readable question and `planning.canAsk`, leave the node `running`, write nothing else, and return `{ outcome: 'asking', question }`.
    3. Otherwise, if `simple && shipsOnItsOwn(mode, stopForMe)`, move the node to `passed` with the auto-start payload and return `{ outcome: 'passed', jobs }`.
    4. Otherwise, park exactly as today.
  - In the orchestrator's plan loop, pass `{ canAsk: k < MAX_REPLANS }`.
  - On `'asking'`:
    1. Step `pid(\`ask-plan-${block.id}\`)` → `askPerson(runId, nodeId, { kind: 'plan', findingId: null, text, why: q.why || strings.plan.questionWhy, options: q.options.map(...)`, plus a `leave` option `{ id: 'leave', label: strings.plan.leaveLabel, means: strings.plan.leaveMeans }`, `recommended: null`, `touches: []`, `paths: q.paths })`.
    2. Wait with `waitForAnswer(step, pid, runId, asked, 'plan-')`.
    3. On `'parked'`, return. On `'cancelled'`, return.
    4. Otherwise set `note = strings.plan.answerNote(q.text, chosenLabel | null, answer.answerText)`, `images = []`, and `continue` to `k + 1`. There is no reopen: the node is `running` again.
  - On `passed` with `jobs`, set `prepared.jobs`.
  - The human branch uses `passesLowRisk(modeOf(plan).mode, modeOf(plan).stopForMe)` instead of `plan.autoApproveLowRisk`.
  - `waitForAnswer` is the loop body moved out of `askAndWait`. Its ids are `` id(`read-answer-${tag}${qid}-first`) ``, `` id(`question-${tag}${qid}-${attempt}`) `` and `` id(`read-answer-${tag}${qid}-${attempt}`) ``. `askAndWait` passes `row.id` as `qid`, so its ids are byte-for-byte unchanged.

  **Strings added (`strings.plan`):**
  - `startedOnItsOwn: 'Simple change, so it started on its own.'`
  - `seePlan: 'See the plan'`
  - `questionWhy: 'The planner needs this decided before it can plan the work.'`
  - `leaveLabel: 'Let the planner choose'`
  - `leaveMeans: 'The planner picks what it thinks is best, and the plan is checked like any other.'`
  - `reasons.everything: 'You chose to be asked about every plan.'`
  - `reasons.smallChanges: 'This project still checks every plan with you.'`
  - `reasons.stopForMe: 'You asked the app to stop for you on this task.'`
  - In `strings.providers.claude`: `answerNote: (q: string, chose: string | null, words: string | null) => \`The person answered your question "${q}": ${chose ? \`they chose "${chose}".\` : 'they left it to you.'}${words ? \` In their words: ${words}\` : ''} Plan the work with that.\``
- [ ] **Step 5:** Run `npx vitest run tests/engine/execute-run-workspace.test.ts tests/engine/questions.test.ts tests/engine/review-stage.test.ts`, then the full check. Expected: PASS.
- [ ] **Step 6: Commit:** `A simple plan starts on its own when the project asks only about what matters, a plan that touches what matters stops and says why, and the planner's question is asked in the question window before it plans again`.

### Task 7: Kept, sent and opened as a pull request on its own, ending softly

**Files:**
- Create: `src/engine/delivery-options.ts`, `src/engine/auto-ship.ts`
- Modify: `src/app/api/runs/[runId]/delivery/route.ts` (uses `keepOptionsFor`), `src/engine/delivery.ts` (`Delivery.autoShip`, `DeliveryError.kind`), `src/engine/ship.ts` (`ShipError.kind`), `src/engine/inngest/execute-run.ts` (steps after `finish`), `src/engine/events.ts`, `src/ui/strings.ts`
- Test: `tests/engine/auto-ship.test.ts`; extend `tests/engine/execute-run-workspace.test.ts`, `tests/engine/delivery.test.ts`

**Interfaces:**
- Consumes: `humanCheckPassedBy` (Task 2); `shipsOnItsOwn` (Task 1); `keepOnBranch`, `pushBranch`, `openPullRequest`, `Gh`.
- Produces:
```ts
// delivery-options.ts — the route's lines, moved
export async function keepOptionsFor(runId: string, name: string, ask?: AskModel): Promise<KeepOptions>
// auto-ship.ts
export type AutoShipDeps = { gh?: Gh; ask?: AskModel }
export type AutoStep = { ok: true } | { ok: false }
export async function shouldShipOnItsOwn(runId: string, mode: AskMode, stopForMe: boolean): Promise<boolean>
export async function autoKeep(runId: string, deps?: AutoShipDeps): Promise<AutoStep>   // records run.auto_ship {state:'started'} once, then keeps
export async function autoSend(runId: string): Promise<AutoStep>
export async function autoOpen(runId: string, deps?: AutoShipDeps): Promise<AutoStep>   // records {state:'opened'} on success
// Delivery gains:
autoShip: { state: 'started' | 'opened' | 'stopped'; step: 'keep' | 'send' | 'open' | null; reason: 'no_connection' | 'failed' | null; message: string | null } | null
// DeliveryError / ShipError constructor gains optional `kind?: 'no_connection'` (set on noRemote, noGh, notLoggedIn, notGitHub)
// ExecutorDeps gains: autoShip?: AutoShipDeps
```
`shouldShipOnItsOwn` returns true only when all of these hold:
- the run is `completed`;
- `providerId` is not the demo;
- `shipsOnItsOwn(askModeOf(project), run.stopForMe)`;
- `humanCheckPassedBy` is not null;
- there is no `run.auto_ship` with state `stopped` or `opened` yet.

The mode is not read from the project again: it comes from the run's memoized `Plan`, because the setting is read once per run (spec §4.5). The orchestrator passes `modeOf(plan)` to the check step.

Each step catches only `DeliveryError` and `ShipError`. It records `run.auto_ship { state: 'stopped', step, reason, message }`, with the message clipped to 300, and returns `{ ok: false }`. Any other error is thrown, and Inngest retries the step. Re-running a step is safe because keep returns early once kept, a push of the same branch is not forced, and open reuses a PR that is already recorded.

In the orchestrator, after `finish`:
```ts
const ship = await step.run('auto-ship-check', () => shouldShipOnItsOwn(runId, mode, stopForMe))
if (ship) { if ((await step.run('auto-ship-keep', …)).ok && (await step.run('auto-ship-send', …)).ok) await step.run('auto-ship-open', …) }
```

**Strings added (`strings.delivery.auto`):**
- `working: 'Sending it to GitHub and opening a pull request for you…'`
- `openedByApp: 'It passed on its own, so it was sent to GitHub and a pull request is open. Publish it when you are ready.'`
- `openedAfterYes: 'You approved it, so it was sent to GitHub and a pull request is open. Publish it when you are ready.'`
- `passedReady: 'It passed on its own. It is ready, but not in your project yet.'`
- `stopped.keep: 'It passed, but it could not be saved on its own branch. Nothing was sent.'`
- `stopped.send: 'It is saved on its own branch on this computer, but it could not be sent to GitHub.'`
- `stopped.open: 'It was sent to GitHub, but the pull request could not be opened.'`
- `stopped.noConnection: 'It is saved on its own branch on this computer. It was not sent, because this project is not connected to GitHub.'`
- `whatHappened: 'What happened'`
- `tryAgain: 'You can try again with the button below.'`

- [ ] **Step 1: Failing tests (`auto-ship.test.ts`).** Each test uses a real git repo from `createProject` and a bare repo in a temp folder as `origin`. `gh` is a fake `Gh` that records its calls. The `AskModel` is a fake that returns `"footer year"` and a commit message.
  - `kept, sent and opened, once each`:
    - After `autoKeep`, `autoSend` and `autoOpen`, the events are `run.kept`, then `run.pushed`, then `run.pr_opened`.
    - `run.auto_ship` is recorded `started` then `opened`.
    - The bare repo has the branch, and `gh` was called with `['pr','create','--base','main','--head',<branch>,'--fill-first']`.
  - `each step is safe to run twice`: calling all three again adds no event, and `gh pr create` was called once.
  - `no origin`: `autoSend` returns `{ ok: false }` and records `{ state: 'stopped', step: 'send', reason: 'no_connection' }`. `deliveryState` shows `kept: true`, and the run status is still `completed`.
  - `gh not signed in` (the fake throws `"To get started with GitHub CLI, please run: gh auth login"`) records `{ step: 'open', reason: 'no_connection', message: strings.ship.notLoggedIn }`.
  - `push refused` (origin points to a missing folder) records `{ step: 'send', reason: 'failed' }`, with the message starting `Git could not push the branch.`
  - `shouldShipOnItsOwn` is false for `everything`, false for `small_changes`, false with `stopForMe`, false for a failed run, false for the demo, and false after a `stopped` record.
  - It is true for a person-approved run in `what_matters`.
- [ ] **Step 2: Failing tests (`execute-run-workspace.test.ts`).**
  - `a simple change reaches an open pull request without the person`: in `what_matters` mode with a low-risk change and fake `autoShip` deps, the run ends `completed` with `run.pr_opened`. Step ids `auto-ship-check`, `auto-ship-keep`, `auto-ship-send` and `auto-ship-open` were each run once.
  - `the person's yes also sends it`: in `what_matters` with a high-risk change, the gate parks. An approval is recorded, and the run gets `run.pr_opened`.
  - In `small_changes` with a low-risk change, it is auto-approved and there is no `run.kept` event.
  - It never merges: `gh` is never called with `merge`.
- [ ] **Step 3:** Run them. Expected: FAIL.
- [ ] **Step 4:** Implement. The delivery route calls `keepOptionsFor` instead of its inline lines, and its behaviour is unchanged (the existing delivery route tests pass). `deliveryState` fills `autoShip` from the latest `run.auto_ship` event.
- [ ] **Step 5:** Run the full check. Expected: PASS.
- [ ] **Step 6: Commit:** `A change that passed is kept, sent to GitHub and opened as a pull request on its own in three steps, and anything missing or refused is said on the card while the change stays kept`.

### Task 8: The screens: one choice, one checkbox, reasons one click away

**Files:**
- Modify: `src/ui/canvas/AgentSettings.tsx`, `src/ui/canvas/AddProjectDialog.tsx`, `src/ui/canvas/ProjectMemory.tsx`, `src/ui/canvas/CanvasScreen.tsx` (composer checkbox, request body, card mode order), `src/ui/canvas/PlanSection.tsx`, `src/ui/canvas/BlockCard.tsx`, `src/ui/canvas/BlockDetails.tsx`, `src/engine/block-details.ts`, `src/ui/canvas/useRunStream.ts`, `src/ui/canvas/ResultPanel.tsx`, `src/ui/canvas/ShipSection.tsx`, `src/ui/strings.ts`
- Test: extend `tests/ui/agent-switch.test.tsx`, `tests/ui/add-project.test.tsx`, `tests/ui/gate-panel.test.tsx`; new `tests/ui/ask-mode.test.tsx`, `tests/ui/plan-reasons.test.tsx`, `tests/ui/auto-ship-card.test.tsx`; `tests/ui/client-bundle.test.ts` must stay green

**Interfaces:**
- Consumes: `ProjectSettings.askMode` (Task 1); `node.plan_measured` and the `autoStarted` payload (Task 6); `Delivery.passedBy` and `Delivery.autoShip` (Tasks 2 and 7).
- Produces:
  - `BlockView` (useRunStream) gains `planMeasure?: { simple: boolean; reasons: string[]; entries: string[] }` and `autoStarted?: boolean`.
  - `BlockDetails` gains `planMeasure` (same shape) and `jobs[].paths?`.

**Strings added:**
- `strings.settings.ask`:
  - `title: 'When should the app stop for you?'`
  - `whatMatters: 'Ask me only about what matters'`
  - `whatMattersHelp: 'Simple changes go on their own, up to a pull request on GitHub. The app stops for you when a change touches sign-in, payments, the database, a core area you marked or one of your decisions. Publishing is always your click.'`
  - `everything: 'Ask me about everything'`
  - `everythingHelp: 'The app stops for you at every plan and before every change is kept.'`
  - `smallChanges: 'Small changes skip my final check'`
  - `smallChangesHelp: 'How this project worked until now: every plan waits for you, small changes skip your final check, and nothing is sent to GitHub on its own. Pick one of the options above to change it.'`
- `strings.memory.decisionsLimit: 'Only a decision that names files or folders can stop a task on its own. A decision written only in words is given to the planner, which may ask you about it, but the app cannot check it.'`
- `strings.composer.stopForMe: 'Stop for me on this one'`
- `strings.composer.stopForMeWhat: 'What is this?'`
- `strings.composer.stopForMeWhy: 'The app waits for you at the plan and before the change is kept, even when it is simple. Tasks that continue this one wait too.'`
- `strings.plan.whyStopped: 'Why it stopped for you'`
- `strings.plan.whyStarted: 'Why it started on its own'`
- `strings.plan.expects: 'What the planner expects to change'`
- `strings.plan.noneExpected: 'The planner did not say.'`

`strings.settings.autoLowLabel` and `autoLowHelp` are removed once nothing uses them.

- [ ] **Step 1: Failing UI tests.**
  - `ask-mode.test.tsx`:
    - Settings with `askMode: 'what_matters'` shows two radio options, labelled `strings.settings.ask.whatMatters` and `.everything`. The first is checked, and `smallChanges` is not on screen.
    - With `askMode: 'small_changes'`, three options are shown and the third is checked.
    - Choosing `everything` sends `PUT { askMode: 'everything' }`.
    - When the PUT fails, the previous choice is restored and `strings.settings.saveFailed` is shown.
    - Each help text is visible under its option, not hidden in a tooltip.
  - `add-project.test.tsx`: the dialog shows the same two options, preselects `whatMatters`, and posts `askMode: 'what_matters'`.
  - `ProjectMemory`: the decisions group shows `strings.memory.decisionsLimit`.
  - Composer:
    - A checkbox labelled `strings.composer.stopForMe` is unchecked by default. Checking it sends `stopForMe: true` in the runs POST body, and the box clears after a run starts.
    - Pressing `strings.composer.stopForMeWhat` shows `stopForMeWhy` inline, with no `window.confirm` or `alert`.
  - `plan-reasons.test.tsx`:
    - A parked plan with `planMeasure.reasons = [sensitive(auth), tooMany(9, 8)]` shows the first reason as one sentence above the jobs. The rest appear only after pressing `strings.plan.whyStopped`.
    - A passed plan with `autoStarted` shows the summary `Simple change, so it started on its own.` and a button `See the plan` that opens the details window. The window has sections `whyStarted`, with the reasons, and `expects`, listing the entries.
  - Card mode: a run that is `waiting_approval` with an open question **and** a waiting plan node shows the question (`mode === 'question'`), not the plan.
  - `auto-ship-card.test.tsx`:
    - `autoShip.state 'started'` shows `strings.delivery.auto.working` and no keep or send buttons.
    - `'opened'` with `passedBy: 'app'` shows `openedByApp`. With `passedBy: 'person'` it shows `openedAfterYes`.
    - `'stopped'` with `step: 'send'` and `reason: 'no_connection'` shows `stopped.noConnection` and `tryAgain`, plus the existing send button. `message` appears only after pressing `whatHappened`.
    - `passedBy: 'app'` with no `autoShip` (small_changes) shows `passedReady` instead of `strings.delivery.ready`.
  - All of these render at a 390 px container width with no horizontal overflow. Assert that `scrollWidth <= clientWidth` on the card root.
- [ ] **Step 2:** Run the new and extended UI tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Radios use the `<label>` + `<input type="radio">` pattern of the existing checkbox, and save on change like `toggleAutoLow` did.
  - The third option renders only when the settings **as loaded** had `small_changes`, so it disappears after the person picks another option and the dialog is reopened.
  - `useRunStream` reads `node.plan_measured` and the `autoStarted` flag.
  - `block-details.ts` reads `node.plan_measured` and `paths`.
  - Reorder the `mode` ternary in `CanvasScreen` so the `asking` check comes before `planWaiting`.
- [ ] **Step 4:** Run the full check, including `tests/ui/client-bundle.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `Settings offer two plain choices, the request box can ask to be stopped, a plan says in one sentence why it stopped or started, and the result card says what was sent on its own`.

### Task 9: Telling the person

**Files:**
- Create: `src/ui/canvas/attention.ts`
- Modify: `src/ui/canvas/CanvasScreen.tsx`, `src/ui/canvas/PastTasks.tsx`, `src/engine/run.ts` (`RunSummary`, `listRuns`), `src/ui/strings.ts`
- Test: `tests/ui/attention.test.ts`, extend `tests/ui/past-tasks.test.tsx`, `tests/engine/run.test.ts`

**Interfaces — Produces:**
```ts
// attention.ts (client-safe: imports strings and types only)
export type Attention = 'answer' | 'publish' | null
export function attentionOf(mode: CardMode, shipReady: boolean): Attention   // plan|question|waiting -> 'answer'; done && shipReady -> 'publish'
export function tabTitle(waiting: number, ready: boolean): string
export function useAttention(input: { attention: Attention; waitingCount: number; taskTitle: string | null }): { offer: 'ask' | 'on' | 'blocked' | 'none'; allow: () => void }
// RunSummary gains: passedOnItsOwn: boolean   (human node completed with autoApproved: true)
```
`shipReady` is `true` when the ship state the result card already reads has an open `pr` and `checksDone && !checksFailed`. `useAttention` does four things:
- sets `document.title` on every change;
- calls `new Notification(text, { body: taskTitle ?? '' })` when `attention` changes to a non-null value, `document.hidden` is true and `Notification.permission === 'granted'`, and never twice for the same `attention` of the same task;
- calls `allow()`, which runs `Notification.requestPermission()` only from a click;
- guards every use of `Notification` for browsers without it, where `offer` is `'none'`.

**Strings added (`strings.tell`):**
- `waitingTitle: (n: number) => \`${n} waiting for you\``
- `readyTitle: 'Ready to publish'`
- `tabTitle` composes `` `${part} · ${strings.app.name}` ``, or `strings.app.name` alone when there is no part.
- `needsAnswer: 'A task needs your answer'`
- `readyToPublish: 'A change is ready to publish'`
- `offer: 'Get a notice from this browser when a task needs you'`
- `on: 'This browser will tell you when a task needs you.'`
- `blocked: 'This browser is set not to show notices from the app. You can change that in its site settings.'`
- `strings.history.wentOnItsOwn: 'Went on its own'`
- `strings.history.waitingForYou: 'Waiting for you'`

- [ ] **Step 1: Failing tests.**
  - `tabTitle(2, false) === '2 waiting for you · AI Factory'`, `tabTitle(0, true) === 'Ready to publish · AI Factory'` and `tabTitle(0, false) === 'AI Factory'`. Use the actual `strings.app.name`.
  - `attentionOf('question', false) === 'answer'`, `attentionOf('done', true) === 'publish'` and `attentionOf('working', true) === null`.
  - `useAttention` with a stubbed `Notification` (granted) and `document.hidden = true`: moving from `null` to `'answer'` creates one notification `'A task needs your answer'`, and re-rendering with the same value creates none.
  - With `hidden = false` it creates none, but the title is still updated.
  - With `permission 'default'` the offer is `'ask'`, and `allow()` calls `requestPermission` once.
  - `listRuns` marks a run whose human node completed with `autoApproved: true` as `passedOnItsOwn: true`, and leaves the others false.
  - `PastTasks` shows `strings.history.wentOnItsOwn` beside such a task.
  - For `status === 'waiting_approval'` it shows `strings.history.waitingForYou` in the waiting colour, in place of the generic status word.
  - The offer button (`strings.tell.offer`) is shown on the command card in `working` mode when the offer is `'ask'`, and it is gone after `allow()`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. `CanvasScreen` already re-fetches the task list through `refreshKey`. Bump `refreshKey` when `runStatus` changes, and count `waiting_approval` from the fetched list, which PastTasks reports through a new `onWaiting?(n)` prop next to `onCount`. Add no new polling.
- [ ] **Step 4:** Run the full check. Expected: PASS.
- [ ] **Step 5: Commit:** `The tab title says how many tasks wait for the person, the browser can tell them when one needs an answer or is ready to publish, and the task list marks what went on its own`.

### Task 10: A look at the real running app

**Files:** none changed, unless a defect is found. Then fix it with its own failing test first, in the task that owns the code, and commit it separately.

- [ ] **Step 1: A separate throwaway database in the local Docker Postgres.** Never use `ai_factory`, and never Neon.
  - `docker compose up -d --wait db`
  - `docker exec ai-factory-db createdb -U factory ai_factory_look`
  - `FACTORY_DB=local LOCAL_DATABASE_URL=postgres://factory:factory@127.0.0.1:54410/ai_factory_look npx tsx --tsconfig tsconfig.json src/db/migrate-cli.ts`
  - Expected: the migrations apply, including `0007_*`.
- [ ] **Step 2: A second copy of the app on its own ports.**
  - Start Inngest: `npx --yes inngest-cli dev --host 127.0.0.1 -p 8299 -u http://127.0.0.1:4200/api/inngest`.
  - Start the app: `FACTORY_DB=local LOCAL_DATABASE_URL=…/ai_factory_look INNGEST_DEV=http://127.0.0.1:8299 FACTORY_MACHINE_ID=look-machine FACTORY_MACHINE_NAME="Look" PATH=<scratch>/fakebin:$PATH node_modules/.bin/next dev -H 127.0.0.1 -p 4200`.
  - Expected: the app opens at `http://127.0.0.1:4200` with no projects. The owner's app on 4100, if it is running, is untouched.
- [ ] **Step 3: Throwaway projects in the scratchpad.**
  - **(a) No remote:** clone a small project (or `git init` one with `src/ui/Footer.tsx`, `src/auth/login.ts`, `package.json` with `"test": "node -e 0"`), then `git remote remove origin`.
  - **(b) With a fake GitHub:** a second clone whose `origin` is a local bare repo, `git init --bare <scratch>/origin.git`.
  - **The `gh` test double:** `<scratch>/fakebin/gh` is an executable shell script.
    - It appends its arguments to `<scratch>/gh-calls.log`.
    - For `pr view <branch> --json …` it exits 1 until `pr create` has run, then prints `{"number":7,"url":"http://127.0.0.1/fake/pull/7","state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[],"mergeCommit":null,"mergedAt":null}`.
    - For `pr create` it writes a marker file and exits 0.
    - It exits 1 with `"unknown command"` for anything else, including `merge`.
    - Nothing reaches GitHub: push goes to the bare repo, and `gh` is the script.
- [ ] **Step 4: Cases to look at.** Run each with the real `claude` provider, and record a screenshot at full width and at 390 px.
  1. Project (b), new project. Settings show "Ask me only about what matters" selected. Request: "Add the current year to the footer".
     - Expected: the plan card says "Simple change, so it started on its own." and "See the plan" shows the jobs and paths.
     - The final check passes on its own, and the card shows "Sending it to GitHub and opening a pull request for you…", then `openedByApp` with "Publish it".
     - `gh-calls.log` has `pr create`, the bare repo has the branch, and the task list says "Went on its own".
  2. Project (b), request: "Let people sign in with a username instead of their email".
     - Expected: the plan stops, and the card says one sentence (`sensitive(auth)` or `asks`).
     - The tab title says "1 waiting for you · AI Factory".
     - With the tab in the background and notifications allowed, one notice "A task needs your answer" appears.
     - If the planner asked, the question window shows its options and "Let the planner choose".
  3. Project (a), same simple request. Expected: the PR step ends softly with `stopped.noConnection`, the change is kept on its branch, the run is "Done", and the send button is offered.
  4. Project (b) with "Stop for me on this one" ticked and the simple request. Expected: the plan stops with `reasons.stopForMe`, and the final check stops even though it is low risk. After "Build it" and Approve, no pull request opens on its own (`shouldShipOnItsOwn` is false with `stopForMe`), and the existing send button is offered.
  5. In psql on `ai_factory_look`, set an existing project row to `ask_mode = NULL, auto_approve_low_risk = true`. Expected: settings show three options with "Small changes skip my final check" selected, the plan stops with `reasons.smallChanges`, and no PR opens.
- [ ] **Step 5: Clean up.** Stop both processes. Run `docker exec ai-factory-db dropdb -U factory ai_factory_look` and delete the scratch clones and `fakebin`. Expected: `git status` in this repo shows only the plan's commits.
- [ ] **Step 6:** Report each case as passed or failed, with its screenshots and the `gh-calls.log` contents. Commit only defect fixes, each with its own test.

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 Intent; §2 goals and anti-goals | 4, 5, 6, 7, 9; anti-goal 1 is tested in Tasks 4, 5 and 6; anti-goal 2 in Tasks 8 and 9 |
| §3 "The finished change" | Unchanged, plus decisions in Task 5 |
| §3 "The plan" (fields, measurement, folder rule, 8 across jobs, one job stops all, re-check on every plan, edit only while stopped) | Tasks 3, 4, 6; edit-only-while-stopped follows from parking, and an auto-started plan offers no edit |
| §3 Decisions (paths block plan and change; words-only stated on screen) | Tasks 4, 5, 8 |
| §3 In doubt → stop | Tasks 3, 4 |
| §3 Backstop | Task 5; the Task 6 gate still measures |
| §4.1 | Tasks 6, 8 |
| §4.2 | Tasks 1, 6 |
| §4.3 | Tasks 2, 7, 8 |
| §4.4 | Task 9 |
| §4.5 (two options, new default, third value shown only when held, per-task box that forces both stops for replans and continuations, read once) | Tasks 1, 6, 8 |
| §5 constraints | Global Constraints; real CLI in Task 3, Step 6 |
| §6 left to the builder | Decisions 1, 3, 5, 7 |

**Type consistency:** `AskMode`, `askModeOf`, `passesLowRisk`, `shipsOnItsOwn`, `PlanQuestion`, `PlannerAnswer`, `measurePlan`, `PlanVerdict`, `DecisionPaths`, `humanCheckPassedBy`, `Delivery.passedBy` and `Delivery.autoShip` are named the same in every task that uses them. The `node.plan_measured` payload `{ blockId, simple, reasons, entries, mode, stopForMe }` is written in Task 6 and read in Task 8.

**Proportion:** There are signatures, test assertions and exact sentences, but no function bodies. The longest blocks are the strings the spec fixes.

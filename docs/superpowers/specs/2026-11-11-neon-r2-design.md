# Shared data: Neon Postgres and Cloudflare R2 — design

> Date: 2026-11-11. Status: draft for the user's approval.

## 1. Intent and why

Today everything AI Factory knows — projects, tasks, their event logs, plans, approvals, titles, the project memory,
before/after pictures, attached images — lives in one SQLite file (`.factory/factory.db`) and two folders on one Mac.
The user wants to open the same app from more than one computer (another Mac, or Windows) and see the same tasks,
memory and history. This is also the first step towards the SaaS the user intends (see the project memory note
"SaaS direction"): the database the app uses now is the one the hosted web will use later.

The user chose, on cost: **Neon** (Postgres, free plan: 1 GB per project) for data, and **Cloudflare R2** (free 10 GB,
no egress fees) for images. They already have R2 for other projects. MongoDB and Supabase were considered and dropped.

## 2. Goals

1. All data the app keeps in the database moves to the Neon project `ai-factory` (`calm-flower-74026166`, branch
   `production`, AWS us-east-1). The connection comes from `DATABASE_URL` in `.env.local`, which `neon env pull`
   already wrote. Nothing else reads or writes `.factory/factory.db` once this lands.
2. Images move to an R2 bucket (`ai-factory-images`): before/after pictures and images attached to a request or a
   decision. The page shows them from the app (the app reads R2 and streams them), so R2 credentials never reach the
   browser.
3. **The user's existing data is copied** (they said yes): every row of every table, keeping ids, timestamps and
   event sequences exactly, and every picture and attachment uploaded to R2. A one-off command does it, prints what it
   copied, and can be re-run safely (it skips what is already there).
4. Opening the app on a second computer, pointed at the same `DATABASE_URL`, shows the same projects, tasks, canvas,
   prompts, plans, memory, titles, approvals and pictures.
5. Every behaviour that exists today keeps working, proven by the existing test suite (642 tests) passing against
   Postgres.

## 3. Non-goals (this step)

- Sign-in, accounts, teams, hosting the web on Vercel. (Next step, with Neon Auth.)
- Running tasks in the cloud or through a CLI runner. Tasks still run on the computer where they are started, with
  its own Inngest dev server, `claude`, git and worktrees.
- Windows-specific fixes (folder picker, the `clonefile` copy). Noted in §8; separate work.
- Neon Realtime, Neon Object Storage, Neon Functions.

## 4. Anti-goals — failure even if it technically works

- **Secrets leave `.env.local`.** No connection string, R2 key or Neon token in code, git, logs, event payloads or the
  browser.
- **Lost or reordered history.** An event log copied with gaps, changed sequences or changed timestamps would make the
  canvas tell a different story. The copy must be exact and verified by counts.
- **Silent half-states.** If Neon is unreachable, the page says so plainly; it never shows an empty project as if the
  data were gone, and never falls back to the old SQLite file without saying.
- **A second computer acting on a working copy it does not have.** Buttons that need the task's worktree
  (Try it on my computer, preview, save/branch, ship, pictures) must not pretend to work elsewhere (§6.4).
- **Slower than today in a way the user feels.** The canvas must not become sluggish because of many small round
  trips; hot paths are batched (§6.3).

## 5. Constraints

- Drizzle stays the data layer. The schema moves from `drizzle-orm/sqlite-core` to `drizzle-orm/pg-core`, keeping
  table and column names and meanings. New Postgres migrations replace the SQLite ones (a fresh `drizzle-pg/` folder);
  the SQLite migrations stay in the repo only as the source the copy command reads.
- Driver: `pg` (node-postgres) through `drizzle-orm/node-postgres`, with the **direct** URL (`DATABASE_URL_UNPOOLED`)
  for everything while the app runs on the person's computer (a long-lived Node process with a small pool of its own;
  session features and advisory locks behave normally). The pooled URL and the serverless driver are for when the
  web is hosted (later).
- Types: SQLite integer booleans become Postgres `boolean`; the copy converts 0/1. Timestamps stay ISO text and JSON
  stays text, so their readers do not change.
- Tests run against **PGlite** (Postgres compiled to WASM, in-process, `drizzle-orm/pglite`): real Postgres semantics,
  no network, no Neon usage, fast. One fresh database per test file.
- Every database call becomes async. Functions that were synchronous because SQLite allowed it become `async`; their
  callers `await` them. No sync-over-async tricks.
- Transactions: SQLite's `behavior: 'immediate'` (21 places) becomes a Postgres transaction plus, where two writers
  could race on the same run, `pg_advisory_xact_lock` keyed on the run id. Event sequence numbers keep their
  guarantee: per run, gap-free, increasing, unique (the unique index on `(run_id, sequence)` stays as the backstop).
- Booleans, JSON-in-text columns and ISO timestamp strings keep their current representation (text stays text), so the
  copy is one-to-one and no reader changes meaning.

## 6. How it works

### 6.1 Configuration

- `.env.local` (already present, git-ignored): `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (from Neon), plus the user adds
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=ai-factory-images`. A typed reader validates
  them at start-up and names the missing one in plain words.
- `npm run db:migrate` applies the Postgres migrations to Neon. The server no longer migrates on start.

### 6.2 Images in R2

- Object keys: `snapshots/<runId>/<shot>.png`, `attachments/<attachmentId>.<ext>`.
- Upload happens where the file is made (the snapshot capture, the attachment upload route). The existing routes that
  serve images (`/api/runs/[runId]/snapshots/[shot]`, attachment previews) read from R2 instead of disk and keep their
  name allow-lists.
- The agent needs attached images as local files (it is told their paths). Before a run starts, its attachments are
  downloaded from R2 into a local cache folder (`.factory/cache/attachments/`), and that path is what the agent sees.
- Deleting a task deletes its R2 objects (snapshots and attachments).

### 6.3 Keeping the canvas fast

- The event stream (`/api/runs/[runId]/events`) today polls SQLite every 250 ms. Against Neon, constant polling would
  keep the free plan's database awake day and night and spend its monthly compute hours. So: one indexed query per
  tick (`run_id = ? AND sequence > ?`), every 1 s **only while the run is live** (queued, running, waiting); once it
  has ended, the stream sends the replay and the caught-up marker and closes. A hidden browser tab closes its stream
  and reopens it when shown again. Other periodic reads (GitHub state, pictures in progress) keep their current
  slower intervals and also stop when the tab is hidden.
- Lists (past tasks, prompts, delivery state) avoid per-row follow-up queries (the past-tasks `onHold` and `title` are
  computed in the same query or one batched query, not one per task).

### 6.4 More than one computer

- Each computer has a machine id, kept in `.factory/machine.json` (created on first start; with a name the person can
  read, from the computer's host name).
- What is per computer moves out of shared rows into a table `project_machines (project_id, machine_id, repo_path,
  base_status, base_message, base_lock_hash, base_commit, …)`: the project's folder path and its prepared base.
  A project opened on a computer that has no path for it asks for the folder (the existing folder picker), the
  same as adding a project.
- A run records the `machine_id` it executes on (`null` for none known: treated as "not this computer"). Its
  `worktree_path` stays on the shared row, meaningful only on that machine. Everything that needs the worktree checks
  the machine: on another computer the card shows the task, its history and pictures, and in place of those buttons
  says plainly "This task's working copy is on <machine name>." Decisions that do not need the worktree work from any
  computer: approve / turn down / ask for changes on the gate, the plan (build / replan), publish / hold (these act on
  GitHub), rename, memory.
- How a decision made on computer B reaches the task running on computer A: every decision is already recorded as a
  row first (approvals, plan events) and only then announced to Inngest. Each decision row gets a `delivered_at`.
  The computer that records it, if it is the run's machine, announces it at once (as today). Otherwise it only
  records it, and the run's own computer delivers it: its app server checks every 5 s for undelivered decisions on
  runs whose `machine_id` is its own, sends the Inngest event to its local Inngest, and marks them delivered. The card
  on B says "Sent. The task's computer (<name>) picks it up when it is on." A cheap indexed query, and it only runs
  while that computer's app is running.
- Attachments: rows keep their id, metadata and R2 key; the local file path is no longer stored. The agent reads them
  from the local cache (§6.2), downloaded on the run's machine before the run starts.

### 6.5 Copying the existing data

- `npm run db:copy-from-sqlite` reads `.factory/factory.db` (read-only) and writes into Neon, table by table in
  foreign-key order, inside one transaction per table, preserving ids and every column. It refuses to run if the
  Neon tables already hold different rows with the same ids, and skips identical ones (re-runnable).
- It then uploads `.factory/snapshots/**` and `.factory/attachments/**` to R2 under the keys of §6.2.
- It runs on the Mac that holds the file. It registers that Mac as the machine for every existing project path and
  run, so their working copies stay usable there.
- It prints per-table counts (SQLite vs Neon) and per-folder file counts, and exits non-zero on any mismatch.
- The SQLite file is left untouched as a backup.

### 6.6 When Neon cannot be reached

- The page: a plain banner ("Can't reach the database. Your data is safe; retrying…") in place of empty lists; the
  canvas keeps what it already shows.
- A running task: Inngest already retries a failed step; a step whose database write fails is retried that way. If
  the database stays unreachable past those retries, the run's failure handler records the failure when the database
  is back (it cannot record it before). Nothing is buffered on disk.

## 7. Testing

- All existing tests pass on PGlite, changed only where they called the database synchronously.
- Every one of the 21 places that relied on SQLite's `immediate` transactions is reviewed: those that read then write
  something counted per run (event sequences, attempts, rounds) take the run's advisory lock; a list of them goes in
  the plan.
- New tests: event sequences stay gap-free under two concurrent writers on one run (advisory lock);
  a decision recorded on another machine is delivered once by the run's machine and not by others; the copy command
  on a fixture SQLite file produces identical rows and counts and is idempotent; machine checks (a run from another
  machine offers no worktree buttons and says where it is); R2 reads and writes through a fake client, and the image
  routes refuse names outside the allow-list.
- End to end, by hand with the user: copy their data, open the canvas and past tasks on this Mac and compare; then open
  it from a second computer.

## 8. Known limits, said plainly

- Windows: the app is not yet tested on Windows; the folder picker and the fast dependency copy are macOS-only today.
- Neon's free plan scales to zero: the first request after a quiet spell can take ~0.5–1 s while it wakes.
- A task keeps running only while its own computer and its Inngest dev server are on.

## 9. Calls made on the builder's behalf (to check)

- Postgres driver `pg` locally (not the serverless driver), PGlite for tests.
- Machine-specific data split into `project_machines`; runs record their machine.
- Images streamed through the app, not public R2 URLs.
- Event polling at 1 s and only while a run is live; hidden tabs stop polling (to stay within the free plan).
- Decisions from another computer are relayed through the database by the run's own computer every 5 s.
- Direct (unpooled) connection while the app runs locally; Postgres booleans.
- `runs.worktree_path` stays shared, guarded by `machine_id`; attachment rows lose their local path.

# Verified implementation — design

> Date: 2026-11-12 · For: Alfredo · Status: draft, waiting for approval
> Builds on `2026-11-10-ai-factory-design.md`. Where the two disagree, this one wins and says so.

## 1. Intent

A person building a large project with AI Factory must be able to trust that the agents:

- build what was agreed and nothing else,
- do not overwrite or break what already works,
- do not contradict a decision taken earlier,
- and can show, for every agreed point, proof that it is met.

Today a task is planned, built in one go, reviewed once by one agent, tested with the project's own commands, and
handed to the person. That is enough for a small change. It is not enough for a large project: nothing checks each
job as it is built, a reviewer's word goes to the builder unverified, a project without tests has no protection, and
nothing remembers what the project has decided or what already works.

The model the user brought (a five-step implementation loop, shown to me as slides) is the target:

1. **Implement and self-check** — one bounded job at a time, checked after each, evidence left for every criterion.
2. **Review with other agents** — several reviewers, given the builder's context, looking at the change *and the
   files around it*.
3. **Check the findings** — is it a real error? Compare with the real code, remove duplicates, order by severity,
   reproduce it before calling it a bug.
4. **Mandatory controls** — tests, compiles, security, requested behaviour. "Finished" is locked until they pass. A
   control that did not run is shown, never hidden.
5. **Fix inside** — every finding ends *corrected* or *discarded with a written reason*. Small ones are fixed
   directly; ones that touch the core of the business or an earlier decision go to the person. Everything is logged.

Then: the person decides (do / do not), the change is checked together with the current main version, and after
publishing the app watches the site and can go back to the stable version.

## 2. Goals, non-goals, anti-goals

**Goals**

- Each job of a plan is built and checked on its own, and the card shows it.
- Each agreed criterion ends with evidence the app measured, or is plainly marked as not checked.
- A finding reaches the builder only after it survived verification.
- No finding is left open: corrected (measured), fixed but not checked (shown as such), or discarded (reason on
  the record).
- The agents decide what is ordinary; a critical decision reaches the person explained, with options (§3.1).
- The person is asked before a fix touches a core area or an earlier decision.
- The project keeps a numbered register of decisions that every agent is given.
- A control that did not run is visible at the human check and never counts as passed.
- The change is checked merged with the current main before the merge button is offered.
- A published change can be undone from the app.

**Non-goals**

- Sign-in, hosting, multi-tenant work (still deferred: local first).
- Production metrics (errors, timings, usage) from a hosting provider. Only a light "does the site still answer"
  watch is in scope (§9).
- New model providers. Everything runs through the existing `claude` CLI adapter.
- The M4 "four reviewers" wording of the earlier design. It is replaced by the three focuses in §5.

**Anti-goals** (failure even if it technically works)

- An agent's "checked ✓" shown as if the app had measured it.
- A skipped control that reads as passed, or is not mentioned.
- A finding dropped with no record of why.
- A fix that changes a core area or contradicts a decision without the person being asked.
- A reviewer or verifier able to change the task's working copy.
- A review loop with no bound.
- An AI clearing the human check.

## 3. Principles carried over (already in the code, to be kept)

- **Claim and evidence are separate.** What a model says is "AI says". What the app ran and measured is evidence
  (`claims` / `evidence` tables, `test_run` evidence, `summarySource`).
- **What cannot be measured counts as high risk** (`risk.ts`). Here it becomes: *in doubt, ask the person*.
- **The executor acts on recorded rows, never on an event alone** (`approvals`).
- **No extra model pass writes prose that is shown as fact.** Sentences are templated from structured data.
- **Bounded loops** (`MAX_REVIEW_ROUNDS`), read-only reviewers (`reviewerArgs`), plain-language UI strings in
  `src/ui/strings.ts`.
- **Neon's free compute:** nothing polls unless something is live or waiting.

### 3.1 Who decides: the agents by default, the person on what is critical

The user's words: the agents take the decisions, but the most critical ones come to me, explained, with options, so
that I take the decision. The person is the narrow neck of the bottle; only what matters should pass through it.

- **Agents decide everything else**, and every decision they take is logged (§5.5) so it can be read later.
- **Critical by default** (the user's examples): the **data model**, **how money is charged**, and **what the user
  sees**. To these are added the project's core areas and anything that touches a standing register entry (§5.1).
- *(My reading)* "What the user sees" is critical when it departs from what the approved plan said the user would
  see. A plan the person approved already is their decision; building it as agreed does not ask again.
- **A critical decision reaches the person as a question with options**, never as a bare yes/no:
  - one plain sentence saying what has to be decided and why it came up;
  - two to four options, each with what it means for the product in one line;
  - the agent's recommended option, marked as its recommendation (a claim);
  - always a way to answer something else in the person's own words.
- The run waits. The answer is a recorded row (who, when, which option, any words they added) and becomes a standing
  `decision` entry in the register, worded from the question and the chosen option — the person's choice, not a
  model's paraphrase of a reviewer.
- This can happen at three moments: in the plan (§6.1, "risk and decisions"), while building (the builder stops
  rather than choosing), and on a finding (§5.4).
- **In doubt, it is critical.**

## 4. The pieces and their order

Six pieces. Each gets its own implementation plan; each is useful when it lands.

| # | Piece | Model steps |
|---|---|---|
| 1 | Decision register + review that verifies its findings | 02, 03, 05, the per-finding risk dial |
| 2 | Build by jobs, with evidence per criterion | plan, 01 |
| 3 | Controls with a lock | 04 |
| 4 | Check together with main | integration |
| 5 | The rest of the project brain | "what the app does, what already works" |
| 6 | After publishing: watch and go back | observe, recover |

Order is my recommendation (the user agreed to 1 first; the rest was not objected to). Piece 1 goes first because it
protects most against broken code and depends on nothing else. Piece 5 needs one more conversation before it is
planned (§8).

## 5. Piece 1 — Decision register and verified review

### 5.1 The decision register

The existing project memory (`project_notes`, `src/engine/memory.ts`: up to 20 short rules distilled from what the
person said) becomes a numbered register.

- Every entry gets a stable number per project, shown as `D-07`. Numbers are never reused.
- Entry kinds:
  - `rule` — what exists today ("do not touch the header").
  - `decision` — a choice the person made on a critical question (§3.1), worded from the question and the option
    they picked. No model decides what is "notable"; only the person's own choices become decisions.
  - `core` — an area the person marked as the core of the business ("payments", "sign-in"), with optional path
    patterns.
  - `finding` — the log line of a resolved finding (§5.5). Not standing: it is history, not an instruction.
- Standing entries (`rule`, `decision`, `core`, enabled) are given to the planner, the builder, every reviewer and
  the verifier. The run records which it was given, as it does today (`run.memory`).
- **Core areas** *(my assumption — the user did not answer this)*: the person marks them once per project in project
  settings. The app proposes candidates by matching the repository's paths against the sensitive-area patterns that
  `risk.ts` already has (a measurement, not a model's opinion). Nothing is core until the person confirms it.

### 5.2 Reviewers

Three reviewers, each with one focus, run in parallel after the builder and the per-job checks:

| Focus | Looks for |
|---|---|
| Logic | wrong logic, missing cases, loops with no exit, unhandled failures — inside the change |
| Security | exposed secrets, missing permission checks, unvalidated input — in what was touched and what it touches |
| Effects elsewhere | callers and dependents of what changed that no longer behave the same |

- Each reviewer is told its focus but may report a finding of any type; the type belongs to the finding.
- Each is given: the request, the approved plan with its criteria, the builder's own summary, the standing register
  entries, the base commit — and is told explicitly to open the files that use what was changed, not only the diff.
  (Today a reviewer gets only the request and the diff.)
- Read-only, exactly as today.
- A finding is: `type` (logic | security | effect), `file`, `line`, `problem`, `severity` (high | medium | low — the
  reviewer's claim), `affects` (other parts of the app, free text), `decisions` (register numbers it believes are
  touched).
- **Depth follows measured risk** *(my call)*: a change that `risk.ts` measures as low gets one reviewer (logic);
  anything else gets all three. This keeps a typo fix from costing three review passes. The card says which ran and
  why.
- On the canvas *(my call)*: still **one Review block**. Inside it the three reviewers run and the card shows one
  line each. Existing projects' flows, which are frozen with a single Review block, keep working with no migration,
  and more agents do not become more cards (§10).
- The reviewers are independent: none sees another's findings. Running them at the same time is an optimisation
  left to the builder; the first version may run them one after another (the executor is sequential today).
- The project's tests and per-job checks run **before** the reviewers, as today, so the risk measurement that sets
  the depth has test results to read. Piece 3's controls run again at the end, on the finished change.

### 5.3 Checking the findings

A new step between the reviewers and the builder. Nothing a reviewer says reaches the builder before it.

1. **Against the real code (app, no model).** The cited file must exist in the working copy and the line must be in
   range. A finding that cites code that is not there is `refuted`, with that reason.
2. **Duplicates (app, no model).** Findings with the same type and the same file within a few lines are merged into
   one, keeping who reported it and how many times (×2).
3. **Order by severity.** High first. The severity stays a claim and is labelled as one.
4. **Backing (one verifier agent per finding, told to assume the finding is false).** It works in a throwaway copy
   of the change, never in the task's working copy. It may write a test or a small script there. It ends with a
   structured answer: reproduced or not, and the exact command. **The app then runs that command itself** and records
   the exit code and output as evidence. Only that record makes a finding `confirmed`.

How a reproduction is kept and judged *(my calls)*:

- The verifier's test or script is stored by the app as evidence, **apart from the task's change**. To run it, the
  app lays it over a fresh throwaway copy of the change as it is at that moment. It never enters the working copy,
  so it is not something the person is asked to approve and does not count as "the tests were changed".
- "Reproduced" is not just a failing exit, because a broken script fails too. The verifier must name the exact line
  the failure will print; the app counts it as reproduced only when the command fails **and** that line is in the
  output. "Corrected" later means the same command passes.
- If the builder wants the test kept in the project, it adds it to the change itself, where it is reviewed and
  shown like any other file.

Each finding leaves this step in one state:

| State | Meaning | What happens |
|---|---|---|
| `confirmed` | cited code is real and the app reproduced it | goes on to §5.4 |
| `unbacked` | cited code is real, but it could not be reproduced | *(my call)* severity high → the person is asked; otherwise discarded, reason "could not be reproduced" |
| `refuted` | cited code is not there, or the verifier showed it false | discarded, reason recorded |

A project with no way to run a command for a finding (no test runner, nothing scriptable) yields `unbacked`, never a
silent pass.

### 5.4 The risk dial: fix directly, or ask

For each confirmed finding:

- **Low → the builder fixes it directly.**
- **High → the run stops and the person is asked**, in the form §3.1 describes: what was found, why it matters,
  the options (for example: fix it this way / fix it that way / leave it as it is), the recommended one, and the
  decision it touches ("Affects D-07"). The finding's evidence is one click away.

A finding is high when any of these holds:

- it is about the data model, how money is charged, or what the user sees beyond the approved plan (§3.1);
- its file is inside a core area or a sensitive path (measured by path);
- a reviewer or the verifier named a register entry it touches (a claim — so it asks);
- anything about it could not be determined.

The question uses the existing "waiting for a person" mechanism (as the plan check and the human check do). "Leave
it as it is" → discarded, with the person's reason.

**A fix that turns out bigger than its finding.** Which files a fix needs is not known beforehand, and the builder
is not restricted. So fixes are made **one finding at a time**: the app keeps a snapshot of the working copy before
each fix and measures what the fix touched. If a "low" fix landed in a core area or sensitive path that the task had
not already been cleared to touch, the fix is held and the person is asked (keep it / undo it / do it differently);
undo restores the snapshot. This costs one builder pass per finding and is the price of the anti-goal in §2.

### 5.5 Fix inside, and the log

- The builder is given the confirmed findings one at a time, high first, each with the command that reproduces it.
- After each fix **the app re-runs that reproduction**. It now passes → `corrected` (measured). It still fails → the
  builder tries again within the existing retry bounds; after that it goes to the person as open, said plainly.
- An unbacked finding the person chose to have fixed has no reproduction to re-run. It ends as **fixed, not
  checked** — shown as "AI says", listed under what is pending (§6.4), never with a measured tick.
- **After the fixes, the project's checks run again and the change is reviewed once more** — only the part the
  fixes changed, with the depth rule of §5.2. New findings go through the same check. This is bounded by the
  existing limit of two rounds; whatever is still open after that reaches the person as pending. A fix is never the
  last thing nobody looked at.
- Every finding ends with a register line of kind `finding`: number, short title, outcome (`done` / `asked — yes` /
  `asked — no` / `discarded`), reason, task. This is the decisions log.
- The person's choice on a high finding also creates a standing `decision` entry (§3.1), so the next task knows.
  The person can reword or switch off any entry in the register.
- The human check shows the list: each finding, its evidence, how it ended.

## 6. Piece 2 — Build by jobs, with evidence

### 6.1 A longer specification: four parts, plus risk and decisions

A job of the plan becomes: what to do, then

1. **what the user will be able to do**,
2. **what result they must get**,
3. **what it must respect**,
4. **how it proves it** — agreed at plan time, before anything is built, not invented by the builder afterwards,

and one more section for the task as a whole: **risk and decisions** — which core areas and register entries the
work touches, and anything the person has to decide before building starts, put to them as a question with
options (§3.1) on the plan card itself.

(Today: a title and one to three "how to tell it is done" lines.)

- The planner is given the standing register and fills "must respect" and "risk and decisions" from it, citing
  numbers.
- If the planner believes a job contradicts a standing entry, the plan card says so before the person approves
  (a claim, labelled). This is the guard against incoherent specs.
- The person edits all of it, as today.

### 6.2 One job at a time

- The executor runs the builder once per job, in order. Each time the builder gets the whole plan for context, the
  one job to do now, and what earlier jobs already did. It is told to do only that job.
- After each job the app runs the project's check commands and records the result against that job. The card shows
  job 1 ✓, job 2 ✓, job 3 running.
- A failed check goes back to the builder with the output, within the existing retry bounds.
- Which commands run after every job versus only at the end is left to the builder of this piece; the slow ones
  (a full production build) may reasonably run only at the controls step.

### 6.3 Evidence per criterion

- The plan already says how each criterion is proved (§6.1, part 4). When a job is done the builder supplies that
  proof: a command or test, a picture (the app already takes before/after pictures), or — said plainly — nothing.
- The app runs each command itself and records pass/fail. That record — not the builder's sentence — is the evidence.
- A criterion with no machine check is shown as "AI says — not checked". It is never shown with a measured tick.
- Preference stated to the builder: evidence as tests committed with the change, because those keep protecting the
  project on every later task (§8).

### 6.4 What reaches the person's hands

This is the outcome the user named as the point of all of it: when a task arrives at the human check, the person
understands it. The window answers three things, in this order, in plain words:

1. **Which requirements are met** — each criterion of the plan, with its state (the app checked it / AI says so /
   not checked).
2. **How each was checked** — the test, command or picture behind it, one click away.
3. **What is still pending** — criteria without proof, controls that did not run, findings that were discarded or
   are waiting for the person.

It is templated from the records, not written by a model. Pieces 1 and 3 add their lines to this same window (the
findings and how each ended; the controls) rather than opening windows of their own.

## 7. Piece 3 — Controls with a lock

Four controls sit between the review and the human check:

| Control | What the app runs |
|---|---|
| Tests | the project's test command (exists) |
| Compiles | the project's build / lint / type-check commands (exist as blocks) |
| Security | a dependency audit when the project's package manager offers one, and a scan of the change for secrets — both run and measured by the app |
| Requested behaviour | every criterion's evidence command, again, on the finished change |

- All four are shown in one list with a state each: passed, failed, or **not run** with the reason (no command,
  turned off by the person, tool missing).
- Failed → "finished" stays locked; the work goes back to the builder or the run fails, as today.
- Not run → never counts as passed and never blocks silently: the human check opens stating it, and the person
  decides.
- The low-risk automatic approval (a per-project switch that exists today) never applies when any control did not
  run. It already refuses when tests did not run; this extends it to all four.

Security therefore appears twice on purpose: a reviewer that reads the code (§5.2) and a tool the app runs (here).

## 8. Piece 5 — The rest of the project brain

*(Listed before pieces 4 and 6 here because 2 and 3 feed it. It is built fifth.)*

What the user asked for: a general brain with every aspect of the app — what it does, what has been achieved, what
already works and must not break. The register (§5.1) is the "what was decided" part. What remains:

- **What has been built** — a log of merged tasks: title, criteria, files touched, date. All of it is already on
  record; this is a view, not a new model pass.
- **What already works** — the criteria evidence of every merged task, kept as the project's growing list of checks.
  Later tasks run them at the controls step. This is the real protection against breaking what works, and it is why
  §6.3 prefers evidence as committed tests.
- **What the app does** — a short map of the app's areas. This part would be written by a model, shown as a claim,
  editable by the person, refreshed when a task is merged.

This piece is the least defined. It needs its own short conversation with the user before a plan is written,
mainly: what the map looks like and who may edit it.

## 9. Pieces 4 and 6 — Around the merge

### 9.1 Piece 4 — Check together with main

The change was built from a copy of main; main may have moved since.

- Before the merge button is offered, the app makes a throwaway copy with the change merged onto the current main and
  runs the controls there. The result is recorded together with the main commit it was run against.
- If main moves again before the merge, that result is stale and the check runs again (the same idea as an approval
  being tied to the exact change that was shown).
- Conflicts are already detected and said; checks that GitHub itself runs are already shown. Both stay.
- This applies whether a person approved the task or it passed the low-risk gate on its own.

### 9.2 Piece 6 — After publishing

- **Go back.** A merged task records the main commit before it (the stable version). A "Go back" button opens a
  change that undoes it, which passes the same controls and the check with main, and is merged only on the person's
  word.
- **Watch** *(my call on scope)*: for a short window after the site answers, the app asks it again a few times and
  records what it got. If it stops answering or starts returning errors, the card says so, next to "Go back". Nothing
  polls outside that window.
- Errors, timings and usage from a hosting provider are out of scope until a specific provider is connected.

## 10. The screen: intuitive and easy to understand

The user asked for this in his own words: every change to the screen must be very intuitive and easy to understand.
This design adds a lot of machinery; none of it may make the canvas harder to read. It is a requirement on every
piece, checked before a piece is called done.

- **One glance answers "is it fine, and does it need me?"** A task shows one plain status. Detail is one click away,
  never on the card by default.
- **Words a person who does not program understands.** "3 problems found, 2 fixed, 1 needs you", not "3 findings, 2
  corrected, 1 escalated". No file paths, register numbers or command output on the first level; they live in "See
  details".
- **Three states look different and are never confused:** the app checked it, AI says so (not checked), not run.
- **A question to the person is one plain sentence and a few options**, each with what it means in one line and the
  recommended one marked (§3.1), with what is being decided shown beside it, as the human check does today.
- **Reuse what the person already knows:** the cards, "See details", the "What is happening" list, the human check
  window. A new kind of window needs a reason.
- **More agents must not mean more cards to read.** The three reviewers, the findings check and the four controls
  each read as one step with a count; they open into their parts on request.
- Each piece's plan includes looking at the real screens in the browser, with a real task, before it is finished.

## 11. Constraints

- Everything is developed and verified on the local test database (`npm run dev`); table changes go through
  `npm run db:generate` and reach Neon only with `npm run db:migrate:neon`. Tests use PGlite.
- Engine code stays free of Mac-only assumptions where cheap (it will move to sandboxes or a CLI runner later).
- More agents per task means more tokens. §5.2's depth-by-risk is the lever; the card always shows what ran.
- Known limit, unchanged: the builder is not sandboxed. A verifier's throwaway copy keeps honest agents apart; it is
  not a security boundary.

## 12. Left to the builder

- Table shapes for the register, findings and per-job records; whether `project_notes` is extended or replaced.
- How the throwaway copies are made (there is precedent in `snapshots.ts` and `base.ts`).
- The exact window for merging duplicate findings; the reviewer, verifier and planner prompts.
- Which checks run after every job and which only at the controls step.
- Canvas layout of the new blocks and the wording of every new string, in the app's plain-language style.
- How many standing register entries an agent is given when a project has many (today: the newest 20).

## 13. Calls I made (not the user's words)

1. Core areas are marked by the person per project; the app proposes candidates from path patterns. The data
   model, how money is charged and what the user sees are critical in every project (those three are the user's).
   (§3.1, §5.1)
2. "What the user sees" asks only when it departs from the approved plan. (§3.1)
3. Review depth follows measured risk: one reviewer for a measured-low change, three otherwise. (§5.2)
4. One Review block that runs the three reviewers inside it; no change to existing projects' flows. (§5.2)
5. A reproduction is kept apart from the task's change, and counts only when the command fails with the line the
   verifier predicted. (§5.3)
6. An unbacked finding: high severity asks the person, otherwise it is discarded with its reason; if the person has
   it fixed anyway it ends "fixed, not checked". (§5.3, §5.5)
7. Fixes are made one finding at a time, with a snapshot before each, so a fix that lands in a core area can be
   held and undone. (§5.4)
8. After the fixes the change is reviewed once more, only the part that changed, within two rounds. (§5.5)
9. The check of each job is run by the app, not taken from the builder's word. (§6.2)
10. "Watch" after publishing is a short "does the site still answer" window, not provider metrics. (§9.2)
11. The order of the six pieces. (§4)

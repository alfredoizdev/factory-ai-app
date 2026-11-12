# Ask me only about what matters — design

Date: 2026-11-12. Status: waiting for the owner's approval. Nothing is built yet.
Builds on `2026-11-12-verified-implementation-design.md` (§3.1 "Who decides") and on Piece 1, which is merged.

## 1. Intent

The owner's words (2026-11-12): "yo sigo siendo el cuello de botella, todo necesita mi aprobación? yo solo quiero
aprobar lógicas de capas más complicadas de business" — with the example that changing sign-in from email to
username is something he does want to decide — and, for simple things such as a UI change, that the AI should
"aprobar y crear el branch y el PR por mí".

Today a task stops for the person three times, whatever its size:

1. **The plan** — always. There is no setting that skips it, and the plan does not say what it expects to touch, so
   the app cannot tell a delicate plan from a simple one.
2. **The final approval** — always, unless the project switch "Do not stop for low-risk changes" is on. It is off by
   default.
3. **Sending to GitHub and opening the pull request** — a button the person presses, even when the change passed on
   its own. Publishing (the merge) is a second button.

Nothing tells the person a task is waiting unless they are looking at the screen.

## 2. Goals, non-goals, anti-goals

**Goals**
- A simple change goes from the request to an open pull request without the person.
- The person is stopped only for what is critical, and is told when that happens.
- Whether a change is simple is **measured by the app**, never a model's opinion.
- Everything that passed on its own says so and says why, on the card and in the task list.

**Non-goals**
- Publishing (merging the pull request) on its own. It stays the person's click.
- Changing what counts as sensitive (the list in `risk.ts`) or the limits (8 files, 300 lines).
- Isolating agents from the person's environment and MCP servers (separate work).
- The rest of Piece 2 (four-part jobs, evidence per criterion).

**Anti-goals** — it has failed if:
- a change that touches sign-in, payments, the database, a core area or an earlier decision reaches a pull request
  without the person having been asked;
- something passes on its own and the person cannot see that it did, or why;
- the person has to learn new words or a new screen to use it.

## 3. What "simple" means (measured)

A change is simple only when **all** of this is true. The first group already exists and decides the final approval
today; the second is new and decides the plan.

**The finished change** (exists — `classifyChange`):
- 8 files or fewer and 300 lines or fewer;
- no sensitive path (secrets, sign-in, payments, database, server/API, configuration, deploy);
- nothing inside a core area the person marked;
- the checks ran and passed, and the change did not edit the tests;
- the review left nothing open, nothing "fixed but not checked", and no reviewer unread.

**The plan** (new):
- the planner lists the files or folders it expects to change (new field on each job);
- none of them is sensitive or inside a core area, and they stay within the same limits;
- the planner raised no question for the person (new, optional: "something you have to decide first", with
  options — the same question window Piece 1 added);
- none of them is a path named by a standing decision of the register (path overlap only — see "Decisions" below).

How the plan's list is read: a folder counts for everything under it; the limit at plan time is 8 entries across
all jobs together (lines are only known at the end); one job that is not simple stops the whole plan. The check runs
again on every new plan (after "ask for another plan"). The person can only edit a plan while it is stopped, so an
edit never follows an automatic start.

**Decisions.** The app can only measure a decision that names paths. A decision with paths blocks the plan and — new —
makes the finished change high risk when the change lands on them (`classifyChange` gains this, next to core
areas). A decision written only in words cannot be measured: it is given to the planner as today, and the planner
may raise a question about it, but the app does not claim to have checked it. This limit is stated on the settings
screen next to the decisions list.

In doubt — the planner gives no expected files, or they cannot be read — the plan is **not** simple and stops, as
today.

**Backstop.** The plan's list is the planner's claim. What decides the pull request is still the measurement of the
finished change. A build that strays into a sensitive path or a core area stops at the final approval even if its
plan passed on its own.

## 4. What changes

### 4.1 The plan
- Simple plan → it is confirmed by the app and Build starts. The Plan card says: "Simple change, so it started on
  its own. See the plan." The plan stays one click away.
- Anything else → stops as today. The card says why in one sentence ("It expects to change sign-in files", "The
  planner needs you to decide something").
- A question raised by the planner is shown on the plan card with its options; the answer is recorded and, when the
  person wrote their own words, becomes a decision (same rule as Piece 1).

### 4.2 The final approval
- Unchanged in what it measures. What changes is the default (see 4.5).

### 4.3 After a change passes on its own
- The app keeps the change on its branch, sends it to GitHub and opens the pull request — the same steps the
  buttons do today, in the same order, recorded the same way.
- No GitHub connection, or `gh` not signed in → the change is kept on its branch on this computer and the card says
  what is missing. Nothing fails.
- Any other failure on the way (push refused, `gh` error) ends the same soft way: the change is kept, the card says
  what happened in one sentence and offers the existing button to try again. No silent retry loop.
- Keep, send and open are three steps with their own stable ids, each safe to run twice.
- The same happens after the person approves a change that had stopped: in the "only what matters" mode their yes
  also sends it and opens the pull request, so approving is one click, not three.
- It never publishes. "Publish it" remains the person's button, and "On hold" keeps working.

### 4.4 Telling the person
- When a task stops for the person, or a pull request is ready: the browser tab's title shows it, and — if the
  person allowed notifications — one browser notification in plain words ("A task needs your answer", "A change is
  ready to publish").
- The task list marks which tasks passed on their own and which are waiting.

### 4.5 The setting
- The project switch becomes one choice with two plain options:
  - **"Ask me only about what matters"** — simple plans and simple changes go on their own, up to an open pull
    request.
  - **"Ask me about everything"** — today's behaviour.
- New projects start on "Ask me only about what matters". Existing projects keep exactly what they do today: a
  project with the old switch on keeps "small changes skip my final check" and nothing more (still stops at the
  plan, still no automatic pull request) until the person picks the new option. So the stored setting has three
  values, and the screen shows the third only for projects that already have it.
- Per task, the box where the person writes the request has one checkbox: "Stop for me on this one". It forces
  both stops for that task, for every new plan of it, and for tasks that continue it (a follow-up, or picking up a
  failed one).
- The setting is read once when the task starts, as today.

## 5. Constraints

- All person-facing words in `src/ui/strings.ts`, plain English, no jargon on the first level; every reason one
  click away (the owner's rule: "bien intuitivo y fácil de entender").
- Reuse the existing cards, the question window and the Ship section; no new screen.
- Every side effect inside an Inngest step with a stable id; an automatic pass is an event in the run's log with its
  reasons, like `autoApproved` today.
- The planner's new fields are a prompt↔parser contract: pinned by tests on both sides and tried with the real
  `claude` CLI before it is called done (Piece 1 lost three defects to this).
- A database change only if needed, as one additive migration; Neon is migrated by the owner.

## 6. Left to the builder

- The exact shape of the planner's new fields and how an unreadable or missing list is treated (it must stop).
- How the automatic "send and open the pull request" reuses `delivery.ts` and `ship.ts` without duplicating them.
- Where the per-task checkbox is stored.
- Whether the tab title or a small badge carries the count.

## 7. Calls I made (not the owner's words)

1. **A UI change is not critical by itself.** The earlier design listed "what the user sees" among critical things.
   The owner now gives UI changes as his example of simple. So a UI change passes when it is small and touches
   nothing sensitive; it stops only if it lands in a core area he marked.
2. **Publishing stays manual.** He asked for the branch and the pull request, not the merge.
3. **Existing projects are not switched silently**; only new ones start in the new mode.
4. **The planner's list is not trusted on its own**; the finished change is measured again (the backstop).
5. **Notifications are browser notifications and the tab title** — no email, no phone. They only work while the
   app is open in a browser tab; a task that stops overnight waits unnoticed until the person looks.
7. **In the new mode, the person's yes on a stopped change also sends it and opens the pull request.**
8. **A decision written only in words cannot stop a plan by measurement**; only one that names paths can.
9. **A project that already had the old switch on is not given the new behaviour** until the person chooses it.
6. **The limits stay** at 8 files and 300 lines.

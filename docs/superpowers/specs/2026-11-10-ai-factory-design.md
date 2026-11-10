# AI Factory — Design Document

> Working name. Date: 2026-11-10. Status: approved for planning.
> Supersedes `AI_FACTORY_PRODUCT_SPEC.md` for v1 scope. That document remains
> useful as the long-term vision; where the two disagree, this one wins.

---

## 1. Intent and why

### What it is

A **local-first control room for AI coding agents**. One canvas where you design
the work *and* watch it happen: agents running in parallel, what each one is
doing right now, what failed and why, who reviewed it, and what is waiting on
your decision.

The canvas is both an **editor** (you build the flow from blocks) and a **live
monitor** (the same blocks light up as the work runs). This dual nature is
non-negotiable — it is the core of the product idea.

### Why now — the problem it solves

The bottleneck in AI-assisted development has moved from *writing* code to
*verifying* it. Evidence (Sonar State of Code 2026, n=1,149 professional
developers; Qodo developer survey; LinearB 2026 benchmark):

- **96%** of developers do not fully trust AI-generated code.
- Only **48%** always review it before committing.
- **42%** of committed code is now AI-generated or AI-assisted.
- **38%** say reviewing AI code takes more work than reviewing a colleague's.
- Reviewing AI code does not take longer so much as it *costs more cognitive
  effort* — the bug hides inside code that looks correct.
- AI-authored PRs wait **4.6x** longer for review and are rejected far more.
- The single most-cited developer complaint is **"almost right" code** —
  considered worse than plainly broken code, because broken code fails loudly.

So: half the new code in the world is entering repositories without anyone
genuinely verifying it, and the people who do verify it are exhausted.

Secondary pain, from the user directly: waiting on an agent to finish because
he does not want to open yet another terminal; not being able to see *why*
something failed without reading everything; and work that should go to a UI
agent being handled as if it were backend work.

### Who it is for

**v1: the author himself**, a solo developer running several coding agents
(primarily Claude Code) across his own projects on macOS.

**Later (only if demand is validated):** small agencies and freelancers who
need to show a non-technical client what the agents did and get sign-off. That
audience is the reason the Business/Dev split exists from day one, but no
cloud, multi-tenant or client portal work happens in v1.

### The one-line pitch

> Design the work. Watch the agents do it. See what a test proves — not what
> the AI claims. Nothing ships without your yes.

---

## 2. Goals

1. **Replace the terminal sprawl.** Several agents run at once; one screen shows
   all of them and what each is doing *right now*.
2. **Make failure legible.** When something stops, the canvas says why, in one
   plain sentence, anchored to the block it came from, with the evidence that
   proves it.
3. **Route work by type.** "Change a button" wakes the UI agent and visibly
   *skips* the data agent.
4. **A model per job.** Cheap model to classify, strong model to build, strongest
   to review. Assigned per block, visible on the block.
5. **Own the review layer.** Specialised reviewers (Security, Experience, Design,
   Code), each with its own model, producing structured findings — not prose.
6. **A gate that cannot be talked around.** The Approver consolidates and blocks;
   a blocking finding stops the flow even when the majority approved.
7. **Close the loop automatically.** A rejection sends the job back to the
   builder with the finding attached, in the same worktree, without a human
   shepherding it.
8. **Two readings, one canvas.** A Business/Dev toggle hides or reveals file
   paths, diffs, tokens and cost — same blocks, same graph, two audiences.
9. **Persistent project memory.** ContextForge holds what the project already
   decided, and every agent reads from it.

## 3. Non-goals for v1

- Cloud hosting, accounts, multi-tenancy, teams, billing.
- Client portal (the Business view exists; the *portal* does not).
- Sandboxing or isolation of untrusted code — it runs on the user's own machine,
  on his own repos, with his own keys.
- A marketplace of agents or a public template library.
- Business Mode flows (sales, marketing, documents, support). The block model
  must not *forbid* them later, but none are built.
- Supporting every provider. One real agent adapter, done properly.
- Mobile.
- Auto-merge or auto-deploy.

## 4. Anti-goals — what would make this a failure even if it technically works

- **Fake activity.** A canvas that animates without a real event behind it. If
  there is no event, there is no light. A demo mode must be labelled as demo and
  must never be mistaken for a real run.
- **Mixing claims with evidence.** The moment "the AI says it's fine" and "the
  test passed" render the same way, the product has lost its only reason to
  exist.
- **Dishonest counters.** Showing `0/4` when three reviews genuinely passed. The
  Approver must show `3 of 4 in favour — still blocked` and name the blocker.
- **An approval gate that can be bypassed by an AI.** The Approver recommends;
  the human decides. A blocking finding cannot be auto-cleared.
- **Becoming a prettier n8n.** If the differentiator becomes "drawing boxes",
  the product is dead — that part is commodity.
- **Busy.** The user rejected two iterations for visual density. A screen that
  needs study before it can be read is a failed screen.
- **An orphan message.** Any error, log line or panel that does not say which
  block it came from.

## 5. Competitive context (why this is not already built)

The "run coding agents in parallel in git worktrees with a dashboard" category
is crowded and largely free: Conductor, Emdash (YC W26), Superset, Octogent,
Agent Cockpit, `codex agents`, plus Claude Code's own fleet features. Factory.ai
(~$150M Series C, April 2026) sells "Missions / Mission Control" — orchestrator,
worker and validator agents against goals and success criteria — which is close
to the original spec's ambition.

**What none of them own is the verification layer.** Every comparison of those
tools names the same unsolved problem: *reviewing many diffs at once*. That is
the gap this product aims at, and it is why the review/approval/evidence
machinery is the product rather than a feature beside the canvas.

**Name collision is real and unresolved.** "AI Factory" sits on top of
Factory.ai's brand and product vocabulary. Renaming is an open decision (§13).

### What is genuinely differentiating

1. **ContextForge as the Brain** — persistent project memory the author already
   owns and ships. Competitors start cold every run, which is why agent #7
   contradicts what was decided last week.
2. **Evidence separated from claims in the data model** — not a UI flourish, a
   separate record type with a different provenance.
3. **Blocking review + human gate** as the centre of the product.
4. **Business/Dev dual reading** of one canvas.
5. **Automatic rejection loop** carrying the finding as input.

### What is *not* differentiating (do not sell these)

Worktrees, parallelism, the canvas itself, per-task model routing. All table
stakes in 2026.

---

## 6. Decisions already made

These came from the user during design and are not open for the builder to
revisit.

### Product shape

- **v1 runs locally on the user's machine.** Cloud later, only if validated.
- **Product language is English.** (The original spec said Spanish-first; that is
  reversed. Keep strings externalised so Spanish can come back later.)
- The canvas is an **editor and a monitor** — the same surface, not two screens.

### Canvas behaviour

- **A collapsed card always carries its result in plain language.** Never just a
  name and a status dot — that was explicitly rejected as useless. Examples that
  were accepted: *"Split into 3 jobs"*, *"Not needed for this change"*,
  *"4 of 5 passed. 1 failed."*, *"Stopped. Nothing ships without your yes."*
- **Expansion happens in place, inside the canvas.** The card grows where it sits,
  its cables stay drawn, neighbours make room. No side inspector panel, no modal,
  no new window. An expanded card carries a breadcrumb of where it sits in the
  chain.
- **Nothing is orphaned.** Every event line names its originating block, with that
  block's colour, and can point at it on the canvas. Evidence inside a card names
  the block that produced it.
- **The expanded card shows what the agent is doing right now** — a short ordered
  list of live steps, not a log dump.

### Visual language (settled, from reference images the user supplied)

- Dark near-black background, subtle perspective grid, restrained ambient glow.
- Rounded cards, thin borders. **Glow only on what matters**: blue for running,
  red for failing, amber for waiting on a human. Everything else is quiet.
- Circular badges on the card corner: blue ✓ for done, red ✗ for failed.
- **The model is written inside the block** (e.g. `✳ Opus`, `◎ Sol`), because
  model-per-job is a selling point and must be visible.
- **Orthogonal (right-angle) cables** with junction dots, drawn on fixed
  coordinates. The path of a failure is drawn in red and can be traced by eye
  from where it was produced to where it stopped the flow.
- Cards are **wide** — text should not wrap mid-phrase.
- Density is a hard constraint: when in doubt, remove.

### Flow semantics

- Reviewers fan out from the builder in parallel and converge on an **Approver**.
- A failing reviewer turns red and marks the Approver red, regardless of majority.
- **The rejection returns to the builder automatically**, drawn as a cable that
  leaves the Approver, crosses under the canvas and re-enters the builder.
- Work happens in a **separate working copy** (`git worktree`); the user's current
  checkout is never touched, and the canvas says so.
- Jobs are built **test-first**: each job shows `test ✓ / code ✓` chips, and a job
  with `test ✗` is where a failure originates.
- **ContextForge is the Brain**, drawn above the flow, feeding every agent.

### Settled after the builder review

- **The canvas is a configurable template, not a free-form graph.** The shape is
  fixed — Input → Plan → Build → Review → Approve → Ship. You add, remove,
  disable, reorder-within-stage and configure blocks inside that shape; you
  cannot wire anything to anything. The graph therefore cannot be made invalid,
  and no generic workflow engine (port type-checking, join rules, cycle policy)
  is needed in v1. A free-form DAG is a later possibility, not a v1 goal.
- **One working copy per run, not per job.** A run gets one `git worktree`, one
  branch, one PR. The jobs inside a run are sequential or parallel *within* that
  copy. **Real parallelism is across runs** — three features in flight means
  three runs, three worktrees, three branches. This is what removes the terminal
  sprawl, and it deletes the entire consolidate-and-resolve-conflicts problem
  that the original spec carried.
- **The builder agent runs unattended inside its worktree.** It may install,
  build, format, generate and run whatever it needs — scoped to that worktree.
  No per-command approval prompts: an approval queue would recreate exactly the
  babysitting the product exists to remove. The human gate sits at the end of
  the flow, not in front of every command.
- **Billing is split by role.** The builder runs through the `claude` CLI on the
  author's subscription (long, expensive work, already paid for). The classifier
  and the four reviewers run through API keys via the AI SDK, each with its own
  model. Consequence: **token and cost figures are shown for reviewers and the
  classifier, and explicitly marked unavailable for the builder.** Never invent
  a cost number — an unavailable cost says "not reported", not "0".

---

## 7. How it works

### Principle

The web UI never executes an agent. API validates → persists → enqueues → a
separate local worker executes → events are persisted → the UI observes. Every
pixel of state on the canvas is derived from a persisted event.

### Runtime shape

A local app started from the CLI, serving a local web UI and running a worker
process. Packaging as a desktop app is a later convenience, not a v1 requirement.

**This is the builder's call to confirm**, but the recommended stack is:

| Layer | Choice | Why |
|---|---|---|
| UI | Next.js + React + TypeScript (strict) | Known to the author; routes and server actions in one place |
| Canvas | `@xyflow/react` | Node/edge editing, viewport, minimap |
| Styling | Tailwind + shadcn/ui | Speed; the visual language in §6 is applied on top |
| Data | SQLite via Drizzle (Postgres-compatible schema) | Local-first, zero setup; migrating to Postgres later must not require a rewrite |
| Durable execution | **Inngest (local dev server) or Temporal** — not a hand-rolled queue | Retries, timeouts, cancellation, crash recovery and *"wait for human approval for three days"* come free. This removes most of the orchestration work |
| Events | Append-only event table + SSE with `sequence` and resume-from | Reconnect without losing history |
| Agents | Claude Agent SDK / `claude` headless first | Use the agent the user already pays for |
| Model access | AI SDK (+ AI Gateway optional) for reviewer/classifier calls | Multi-model without N providers wired by hand |
| Memory | ContextForge MCP | Already built and owned |
| GitHub | GitHub App + Octokit, signed webhooks | Last milestone only |

The durable-execution choice is the single highest-leverage technical decision
here: a hand-written queue plus state machine is where this kind of project
stalls for weeks.

### Reuse what the author already owns

Two of the three hard layers already exist as shipped products of the author's:

- **Runtape** — a flight recorder for AI coding agents. Its CLI installs Claude
  Code hooks (`~/.claude/settings.json`) and maps them to typed events
  (`SessionStart → session_start`, `UserPromptSubmit → user_prompt`, tool calls,
  file edits, plus subagent capture by transcript scan, since Claude Code emits
  no hooks inside `Task` calls). It already has an ingestion API, run lifecycle
  semantics and session replay. Source: `~/Desktop/hindsight-app/hindsight-cli/`,
  hook mapping in `src/lib/hook-mapping.ts`.
- **ContextForge** — persistent project memory, already used as an MCP server.

**Step 6 below is therefore an integration, not a build.** The builder should
read Runtape's hook mapping and event schema first and decide between reusing the
CLI as-is, importing its mapping module, or running the local app as another
ingestion target. Rebuilding hook capture from scratch is waste.

What is genuinely new is the middle: the orchestrator, the canvas, and the
review/approval layer — which is also the only part that differentiates.

### Visual depth — 2.5D, not 3D

Two surfaces, two answers. The user asked for 3D twice; this is how it lands
without costing legibility.

**The main canvas stays 2.5D.** Real 3D here is rejected: overlapping nodes, text
distorted by perspective, and state that needs camera movement to read — the
opposite of the goal. The reference images the user supplied are *flat cards on a
pseudo-3D environment*, and that is the target. Depth comes from the perspective
grid, layered glow, card elevation on hover, parallax on pan, and particles
travelling along a cable while an agent works. All CSS/SVG, no 3D engine.

**The Hangar is real 3D, and it is in scope.** A separate overview surface where
each active run is a lane receding into depth, and you read *volume and health*
rather than detail: how many runs are in flight, which are red, which are waiting
on you. Nothing on it needs to be read as text, which is exactly why 3D works
there and not on the canvas. Clicking a lane flies into that run's 2.5D canvas.
Built with React Three Fiber, driven by the same event stream — it must never
show anything the canvas would not.

### What happens when you press Run

0. **The request enters.** Either the user types it ("make the login button blue
   with a spinner") or it arrives attached to a source the Input block is wired
   to — a Sentry error, a GitHub issue. A run always has one request as its root.
1. The draft graph is validated and **frozen into an immutable version**. Editing
   the canvas afterwards does not alter a run in flight.
2. A run is created; each node becomes a `NodeRun` in `queued`.
3. The **classifier** (cheap model) labels the request by type and marks
   irrelevant agent branches `skipped` — visibly, with a reason.
4. The **planner** turns the request into N `Job` rows with acceptance criteria
   ("Split into 3 jobs"). Jobs are *generated*, then editable by the user before
   building starts. This block is what the canvas calls **The plan**, and it is
   part of v1 — nothing downstream works without it.
5. The worker creates **one `git worktree`** off the base branch for the whole
   run, and spawns the **coding agent headless** inside it, with the jobs as its
   work list. The user's checkout is never touched. Concurrent *runs* get
   separate worktrees and never share a directory.
6. The agent reports through **hooks**: every tool call, file edit and command
   becomes an event with a monotonic sequence number. The canvas is driven by
   these events — if no event arrives, nothing lights up.
7. **Tests run as the evidence producer.** Agent output and test output are stored
   as *different record types* with different provenance. The UI renders them
   differently and never merges them.
   - **The `test ✓` chip is derived, never reported.** It renders only from a
     real test-run record produced by the test runner. If the system cannot
     prove a test ran — and, for the test-first claim, that it ran and failed
     *before* the code that fixes it — the chip is not shown. A chip sourced
     from the agent's own say-so would be a claim dressed as evidence, which is
     anti-goal #2.
   - **Test command discovery:** configured per project, pre-filled by detecting
     the obvious (`package.json` scripts, a Makefile target). That configured
     command *is* the allow-list. Nothing outside it runs as an evidence step.
8. **Reviewers** run as separate agent executions against the run's diff, each
   with its own model and prompt, returning **structured JSON findings**
   (`type, status, severity, title, file, line, explanation, recommendation,
   evidenceRefs[]`) — never free prose.
   - **A Finding is a Claim that cites Evidence.** It is an LLM assertion and is
     stored and rendered as one. `evidenceRefs[]` may point only at records
     produced by something that is not a language model: test runs, command exit
     codes, git diffs and commits, CI check results, file hashes. A finding with
     no evidence refs is still shown — labelled as an unverified observation,
     and it cannot by itself block.
9. The **Approver** consolidates. Policy: a blocking finding (configurable, default
   = security high/critical, or any failing test) blocks regardless of the count.
   It shows the real tally and names the blocker. It cannot clear a block itself.
10. On block, the finding is injected as new input to the builder **in the same
    worktree** and the job re-runs — the return loop — under a bounded retry
    policy (max attempts, then it stops and waits for the human).
11. On pass, the flow reaches **Your call**: it waits, indefinitely, for a human
    decision, which is recorded with actor, reason and timestamp. Reaching this
    state (or failing outright) fires a **macOS notification** — the point is to
    stop watching the screen, so the app must be able to reach out. The local
    worker sends it; no Electron wrapper is required for this.
12. Only after approval do GitHub actions become available (branch push, PR).

### ContextForge: how the Brain is actually wired

The **worker** retrieves from ContextForge and injects a bounded summary into
each agent's prompt. Agents do not call the MCP server ad hoc — if they could
choose not to look, the guarantee evaporates and behaviour stops being
reproducible. Retrieval is scoped to the project, ranked by relevance to the
request, and capped by a token budget set per agent role.

Written back on the way out: **approved decisions, blocking findings, and
rejections with their reason**. Not raw logs, not diffs.

This is wired at **M3, not M5**. Agents that run cold through M3 and M4 are
exactly the failure the product exists to prevent, and the prompt architecture
cannot be retrofitted cheaply afterwards.

### Data model (sketch)

`Project` (**one project = one local repo path**), `Workflow`, `WorkflowVersion`
(frozen JSON graph + hash), `Run` (**↔ worktree ↔ branch**, + base branch,
request text, source ref), `NodeRun` (+ stored plain-language summary),
`Job` (belongs to a Run; goal, acceptance criteria, status, authored-or-generated
flag), `AgentDefinition` (role, model, provider, budget), `Event` (sequence,
type, nodeRunId, payload, timestamp), `Claim` vs `Evidence`
(**deliberately separate tables**), `Review` (+ `Finding`, a kind of Claim),
`Approval`, `Artifact`, `UsageRecord`.

IDs are ULIDs, timestamps UTC. Even with a single local user, keep a
`projectId`/`workspaceId` on every row so the cloud version is not a rewrite.

**Worktree lifecycle:** created per run off a base branch chosen at launch;
branch named from the run (`factory/<run-slug>`). Kept after the run ends so the
work can be inspected — pruning is an explicit action, offered once the run is
approved-and-shipped or discarded, and the UI reports disk used by stale
worktrees. A worktree is never silently deleted while it holds uncommitted work.

### Agent adapter contract

```ts
interface AgentProvider {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  execute(input: AgentExecutionInput, controls: ExecutionControls): AsyncIterable<AgentEvent>;
  cancel?(providerRunId: string): Promise<void>;
}
```

Ship two: a deterministic `DemoAgentProvider` (reproducible, clearly labelled
Demo) and one real adapter. Do not wire more until the first one is solid.

---

## 8. Build order

Each milestone ends with a demonstrable behaviour, not a layer.

**M0 — Skeleton.** App boots, strict TS, schema + migrations, seed project, the
canvas renders a saved graph, lint/typecheck/tests green.
*Done when:* create a project, reload, it is still there.

**M1 — Canvas as editor.** Add/move/connect/delete blocks, inspector editing,
graph validation with visible errors, draft vs published version.
*Done when:* an invalid connection is refused and a published version is frozen.

**M2 — Canvas as monitor.** Durable execution wired, event log, SSE with resume,
states, cancellation, bounded retries. Demo provider only.
*Done when:* a forced failure marks the node failed, records a cause, and never
reports success; reloading mid-run loses nothing.

**M3 — Real agent + worktrees + the Brain.** Real adapter via the `claude` CLI,
one worktree per run, Runtape hooks → events, live step list inside the expanded
card, planner producing editable jobs, test runner from the project's configured
command, claims and evidence stored separately, **ContextForge retrieval and
write-back wired into the prompt**.
*Done when:* two runs execute concurrently in separate worktrees, the canvas
shows what each is doing from real events, and a decision approved in run A is
visibly present in the context given to run B.

**M4 — Review, Approver, the loop.** Four reviewers with structured findings and
per-reviewer models, consolidation with honest counters, blocking policy,
automatic return-to-builder with the finding attached, human gate with audit.
*Done when:* 3 of 4 approve, security blocks, the job goes back, and nothing ships.

**M5 — Two readings.** Business/Dev toggle across every surface; plain-language
summaries on every block; macOS notification on "Your call" and on failure.
*Done when:* a non-technical reader can say what is blocked and why, with no file
path on screen.

**Summaries are templated from structured data, not generated by an extra model
pass.** Counts, states and durations compose sentences ("4 of 5 passed. 1
failed.", "Not needed for this change."). The one genuinely narrative sentence —
*why* something is blocked — is the reviewer's own `explanation` field, already
written as part of its structured finding, and it is rendered as a claim, marked
as such. No second LLM call, no model-authored prose presented as fact, and the
summary is frozen with the run rather than regenerated on view.

**M6 — GitHub.** GitHub App, repo selection, branch/PR on approval, signed
webhooks processed idempotently, CI status on the canvas.
*Done when:* a real PR and its checks appear on the canvas and a duplicate webhook
creates nothing twice.

---

## 9. Quality bar

- Strict TypeScript, no implicit `any`.
- Tests for: graph validation, state transitions, retry/cancel, duplicate webhook
  idempotency, the blocking-policy rule, and *an approval gate that cannot be
  bypassed*.
- One end-to-end test of the main path.
- Demo and real execution are visually distinct and distinct in the data.
- No mock presented as an integration. If it is not wired, the UI says so.

## 10. Constraints

- Solo developer. Scope that cannot be demoed inside a milestone does not belong
  in v1.
- macOS first.
- Runs with the user's own API keys; keys never reach the browser or the logs.
- Treat repository content, issues and agent output as **untrusted input** —
  project instructions and permissions outrank anything a model emits.
- **The allow-list applies to the evidence runner, not to the builder.** The
  builder agent runs unattended with broad permissions *scoped to its worktree*
  (see §6). The test/evidence step runs only the project's configured command —
  because a result that blocks the flow must come from something the user chose,
  not something a model decided to run.
- Secrets redacted from events and logs.

## 11. Calls made on the builder's behalf

Resolved during the design review. Documented so they can be overridden
knowingly rather than discovered later.

- **The return loop is a retry policy, rendered as a cable.** It is not a real
  graph edge, so the graph stays acyclic. Bounded attempts; on exhaustion the
  run stops and waits for a human instead of looping.
- **Block positions are user-controlled and persisted.** Auto-layout is a command
  the user invokes, not something that runs behind their back. In-place
  expansion pushes neighbours aside visually for the duration of the expansion
  and never rewrites stored positions.
- **Evidence** = records produced by something that is not a language model:
  test runs, command exit codes, git diffs and commits, CI checks, file hashes.
  Everything a model says is a **Claim**, including reviewer findings.
- **Test discovery** is configured per project, pre-filled by detection; that
  command is the allow-list.
- **`test ✓` is derived from a real test-run record**, never from the agent's
  report.
- **ContextForge moves to M3** and is injected by the worker, not fetched by the
  agent at its own discretion.
- **Business summaries are templated**, with the one narrative sentence taken
  from the reviewer's structured `explanation` and marked as a claim.
- **macOS notification on "Your call" and on failure**, sent from the local
  worker — no Electron needed for it.
- **One project = one local repo path.** Base branch chosen per run, branch named
  `factory/<run-slug>`, worktrees kept until explicitly pruned.
- **Cost is shown only where the provider reports it** (reviewers, classifier)
  and marked unavailable for the builder. Never a fabricated zero.

## 12. Left to the builder

- Whether the local app is served from a CLI or wrapped in Electron (the
  notification requirement does **not** force Electron).
- Inngest vs Temporal vs another durable engine (but **not** a hand-rolled queue).
- Component structure, file layout, test framework.
- Exact prompt text for each reviewer role.
- How the live step list is summarised from the hook event stream.
- Canvas auto-layout algorithm.

## 13. Open questions

1. **The name.** "AI Factory" collides with Factory.ai's brand and product
   language. Needs resolving before anything public.
2. **Does the user want to validate demand with agencies before M5–M6?** The
   design assumes building first, validating later — which is the user's call,
   already made, but worth revisiting at M4.

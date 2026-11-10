# AI Factory — M0–M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local app where you design a flow on a canvas, press Run, and watch a demo execution light up the same canvas from real engine events — with honest failure, bounded retries, cancellation, and nothing lost on reload.

**Architecture:** Next.js app + a durable execution function (Inngest) in the same process. The UI never executes anything: it writes a draft graph, publishes a frozen version, creates a run, and then *observes* an append-only event log over SSE. The canvas is a configurable template, not a free-form graph — edges are derived from a fixed stage order, so an invalid graph cannot be drawn.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, React, Tailwind + shadcn/ui, `@xyflow/react`, SQLite via Drizzle (`better-sqlite3`), Inngest, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-ai-factory-design.md`

## Global Constraints

- TypeScript strict; no implicit `any`.
- Product UI language is **English**. All user-facing strings go through a single module so Spanish can return later.
- **No fabricated state.** A node's visual state derives only from persisted events. If no event says a node started, it is not running.
- **Claims and Evidence are separate tables** and render differently. Anything a model says is a Claim.
- **A collapsed card always carries a plain-language result line.** Never name + status alone.
- **Expansion happens in place** on the canvas: no modal, no side inspector, no new window.
- **No orphan messages.** Every event line names its originating block and can point at it.
- **Cost/tokens are shown only where reported.** Unknown renders as "not reported", never `0`.
- Demo execution is visibly labelled **Demo** and stored with `provider_id = 'demo'`.
- Colours and glow come from `src/ui/theme.ts`; no hard-coded hex in components.

## Review Focus

1. **SSE reconnect after sleep/offline** — client resumes from its last sequence and sees every missed event exactly once, no gaps, no duplicates. *(Task 13)*
2. **Two runs of the same workflow at once** — sequence numbers are per-run; events never leak into the other run's stream. *(Task 6)*
3. **Canvas edited while a run is in flight** — the running run keeps using its frozen version; the edit lands on the draft only. *(Task 7)*
4. **A node that goes silent** (provider hangs, emits nothing) — the node times out, is marked `failed` with cause `timeout`, and the run does not hang in `running` forever. *(Task 12)*
5. **Unknown cost/tokens** — a node with no usage data renders "not reported"; a zero is never substituted. *(Task 8)*

---

## File Structure

```
src/
├─ app/
│  ├─ layout.tsx                        Shell: rail nav, theme
│  ├─ page.tsx                          Overview: projects + recent runs
│  ├─ canvas/[workflowId]/page.tsx      The canvas screen
│  └─ api/
│     ├─ workflows/[id]/draft/route.ts  PUT draft graph
│     ├─ workflows/[id]/publish/route.ts POST freeze version
│     ├─ workflows/[id]/runs/route.ts   POST create run
│     ├─ runs/[runId]/events/route.ts   GET SSE, resume via ?after=
│     ├─ runs/[runId]/cancel/route.ts   POST cancel
│     └─ inngest/route.ts               Inngest handler
├─ db/
│  ├─ schema.ts                         Drizzle tables
│  ├─ client.ts                         db singleton
│  └─ seed.ts                           demo project + workflow
├─ domain/
│  ├─ graph.ts                          Block/Graph types, derived edges, validation
│  ├─ states.ts                         NodeState + legal transitions
│  └─ summary.ts                        Templated plain-language result lines
├─ engine/
│  ├─ events.ts                         appendEvent / eventsSince, per-run sequence
│  ├─ run.ts                            publishVersion / createRun / cancelRun
│  └─ inngest/
│     ├─ client.ts                      Inngest client + event types
│     └─ execute-run.ts                 The durable run function
├─ providers/
│  ├─ types.ts                          AgentProvider contract
│  └─ demo.ts                           Deterministic DemoAgentProvider
├─ ui/
│  ├─ theme.ts                          Colour/glow/elevation tokens
│  ├─ strings.ts                        All user-facing copy
│  ├─ canvas/
│  │  ├─ Canvas.tsx                     xyflow wiring, derived edges
│  │  ├─ BlockCard.tsx                  Collapsed + expanded card
│  │  └─ useRunStream.ts                SSE client with resume
│  └─ EventBar.tsx                      Bottom bar, names its block
└─ tests/ (mirrors src), e2e/
```

---

### Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `tailwind.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/ui/theme.ts`, `src/ui/strings.ts`
- Test: `tests/ui/theme.test.ts`

**Interfaces:**
- Produces: `theme` from `src/ui/theme.ts` with keys `bg`, `card`, `border`, `running`, `passed`, `failed`, `waiting`, `skipped`, and `glow(state: VisualState): string` where `export type VisualState = 'running'|'passed'|'failed'|'waiting'|'skipped'`; `strings` record from `src/ui/strings.ts`.

`VisualState` is deliberately the *visual* vocabulary and is defined here, not in `domain/states.ts` — Task 8 maps the domain `NodeState` onto it (`waiting_approval → waiting`, `queued → skipped`'s neutral treatment, `blocked → failed`), so the UI layer never imports domain states into the theme.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ui/theme.test.ts
import { theme } from '@/ui/theme'
test('every node state has a colour and a glow', () => {
  for (const s of ['running','passed','failed','waiting','skipped'] as const) {
    expect(theme[s]).toMatch(/^#|^rgb/)
    expect(theme.glow(s)).toContain('rgba')
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ui/theme.test.ts`
Expected: FAIL — cannot resolve `@/ui/theme`.

- [ ] **Step 3: Scaffold the app and implement `theme` and `strings`**

`npx create-next-app@16.0.0` with TypeScript, Tailwind, App Router, `src/` dir. Set `"strict": true` and `"noUncheckedIndexedAccess": true` in `tsconfig.json`. Add Vitest with the `@` path alias. `theme.glow(state: NodeState): string` returns a CSS `box-shadow` string.

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold Next.js app with strict TS, theme and string tokens"
```

---

### Task 2: Database schema and seed

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/seed.ts`, `drizzle.config.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: tables `projects`, `workflows`, `workflowVersions`, `runs`, `nodeRuns`, `jobs`, `events`, `claims`, `evidence`, `usageRecords`; `db` from `src/db/client.ts`; `seedDemoProject(): Promise<{projectId: string; workflowId: string}>`.

Columns that later tasks depend on: `workflowVersions.graphJson` (text), `workflowVersions.hash` (text), `runs.versionId`, `runs.status`, `runs.request`, `runs.providerId`, `nodeRuns.runId`, `nodeRuns.blockId`, `nodeRuns.state`, `nodeRuns.attempt`, `nodeRuns.summary`, `nodeRuns.failureCause`, `events.runId`, `events.sequence` (integer), `events.type`, `events.payloadJson`, `usageRecords.nodeRunId`, `usageRecords.tokens` (integer, **nullable**), `usageRecords.costCents` (integer, **nullable**).

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/schema.test.ts
test('seed creates one project with one workflow and a demo graph', async () => {
  const { projectId, workflowId } = await seedDemoProject()
  const wf = await db.query.workflows.findFirst({ where: eq(workflows.id, workflowId) })
  expect(wf?.projectId).toBe(projectId)
  expect(JSON.parse(wf!.draftJson).blocks.length).toBeGreaterThanOrEqual(6)
})

test('usage tokens and cost are nullable, not defaulted to zero', async () => {
  const row = await insertUsage({ nodeRunId: 'n1' })
  expect(row.tokens).toBeNull()
  expect(row.costCents).toBeNull()
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/db/schema.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement the schema, client and seed**

Drizzle + `better-sqlite3`, file at `./.factory/factory.db`. IDs are ULIDs (`ulid` package), timestamps stored as ISO UTC strings. Every row carries `projectId`. `events` gets a unique index on `(runId, sequence)`. The seed's draft graph is the eight-block default template from Task 3's `defaultGraph()`.

- [ ] **Step 4: Verify**

Run: `npx drizzle-kit generate && npx vitest run tests/db` — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: database schema, client and demo seed"
```

---

### Task 3: The template graph and its validation

**Files:**
- Create: `src/domain/graph.ts`
- Test: `tests/domain/graph.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BlockKind = 'input'|'plan'|'build'|'tests'|'review'|'approve'|'human'|'ship'
  export type Block = { id: string; kind: BlockKind; label: string; enabled: boolean; config: Record<string, unknown>; position: { x: number; y: number } }
  export type Graph = { blocks: Block[] }
  export type Edge = { from: string; to: string; kind: 'normal' | 'return' }
  export type ValidationIssue = { blockId: string | null; code: 'missing_required_stage'|'duplicate_singleton'|'disabled_required'|'unconfigured'; message: string }
  export const STAGE_ORDER: readonly BlockKind[]
  export const SINGLETON_KINDS: readonly BlockKind[]   // input, plan, build, approve, human, ship
  export const REQUIRED_KINDS: readonly BlockKind[]    // input, build, human
  export function defaultGraph(): Graph
  export function derivedEdges(graph: Graph): Edge[]
  export function validateGraph(graph: Graph): ValidationIssue[]
  ```

This is where the "configurable template, not free-form graph" decision lives: **edges are computed, never stored.** `derivedEdges` connects each enabled block to the next enabled stage in `STAGE_ORDER`, fans `build → review*` when several review blocks exist, converges `review* → approve`, and emits one `kind: 'return'` edge from `approve` back to `build`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/graph.test.ts
test('edges are derived from stage order, not stored', () => {
  const g = defaultGraph()
  const e = derivedEdges(g)
  expect(e.some(x => x.kind === 'return')).toBe(true)
  expect(JSON.stringify(g)).not.toContain('"edges"')
})

test('disabling a middle block reconnects its neighbours', () => {
  const g = defaultGraph()
  const tests = g.blocks.find(b => b.kind === 'tests')!
  tests.enabled = false
  const ids = derivedEdges(g).map(e => `${kindOf(g, e.from)}->${kindOf(g, e.to)}`)
  expect(ids).toContain('build->review')
  expect(ids.some(s => s.includes('tests'))).toBe(false)
})

test('four review blocks fan out from build and converge on approve', () => {
  const g = withReviewers(defaultGraph(), 4)
  const e = derivedEdges(g).filter(x => x.kind === 'normal')
  expect(e.filter(x => kindOf(g, x.from) === 'build' && kindOf(g, x.to) === 'review')).toHaveLength(4)
  expect(e.filter(x => kindOf(g, x.to) === 'approve')).toHaveLength(4)
})

test('removing a required block is a validation issue', () => {
  const g = { blocks: defaultGraph().blocks.filter(b => b.kind !== 'build') }
  expect(validateGraph(g).map(i => i.code)).toContain('missing_required_stage')
})

test('a second build block is rejected as a duplicate singleton', () => {
  const g = defaultGraph()
  g.blocks.push({ ...g.blocks.find(b => b.kind === 'build')!, id: 'dup' })
  expect(validateGraph(g).map(i => i.code)).toContain('duplicate_singleton')
})

test('the default graph is valid', () => {
  expect(validateGraph(defaultGraph())).toEqual([])
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/domain/graph.test.ts` — FAIL.

- [ ] **Step 3: Implement `src/domain/graph.ts`**

`defaultGraph()` returns the eight blocks in `STAGE_ORDER` with sensible labels from `strings`, `enabled: true`, and positions spaced on a horizontal lane.

- [ ] **Step 4: Verify** — `npx vitest run tests/domain` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: template graph with derived edges and validation"
```

---

### Task 4: Node state machine

**Files:**
- Create: `src/domain/states.ts`
- Test: `tests/domain/states.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NodeState = 'queued'|'running'|'waiting_approval'|'passed'|'failed'|'cancelled'|'skipped'|'blocked'
  export type RunStatus = 'queued'|'running'|'waiting_approval'|'completed'|'failed'|'cancelled'
  export function canTransition(from: NodeState, to: NodeState): boolean
  export function isTerminal(state: NodeState): boolean
  export function rollUpRunStatus(nodeStates: NodeState[]): RunStatus
  ```

- [ ] **Step 1: Write the failing test**

```ts
test('a terminal state cannot move again', () => {
  expect(canTransition('passed', 'running')).toBe(false)
  expect(canTransition('cancelled', 'queued')).toBe(false)
})
test('a failed node makes the run failed even when others passed', () => {
  expect(rollUpRunStatus(['passed','passed','failed'])).toBe('failed')
})
test('a run waiting on a human is not completed', () => {
  expect(rollUpRunStatus(['passed','waiting_approval'])).toBe('waiting_approval')
})
test('skipped nodes do not block completion', () => {
  expect(rollUpRunStatus(['passed','skipped'])).toBe('completed')
})
```

- [ ] **Step 2: Run and watch it fail.** `npx vitest run tests/domain/states.test.ts`

- [ ] **Step 3: Implement `src/domain/states.ts`** as a transition map plus a roll-up whose precedence is `failed > cancelled > waiting_approval > running > queued > completed`.

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: node state machine and run roll-up"`

---

### Task 5: Plain-language summaries

**Files:**
- Create: `src/domain/summary.ts`
- Test: `tests/domain/summary.test.ts`

**Interfaces:**
- Produces: `export function summarize(input: SummaryInput): string` where
  `SummaryInput = { kind: BlockKind; state: NodeState; counts?: { passed: number; failed: number; total: number }; jobCount?: number; skippedReason?: string; claim?: string }`

Templated only. No model call. The one narrative sentence comes in as `claim` and is returned verbatim; everything else is composed from counts and state.

- [ ] **Step 1: Write the failing test**

```ts
test('a skipped block says why', () => {
  expect(summarize({ kind:'build', state:'skipped', skippedReason:'Not needed for this change' }))
    .toBe('Not needed for this change')
})
test('tests report real counts, never a bare pass', () => {
  expect(summarize({ kind:'tests', state:'failed', counts:{passed:4, failed:1, total:5} }))
    .toBe('4 of 5 passed. 1 failed.')
})
test('the human gate states that nothing proceeds', () => {
  expect(summarize({ kind:'human', state:'waiting_approval' }))
    .toBe('Stopped. Nothing ships without your yes.')
})
test('a collapsed card is never empty', () => {
  for (const kind of STAGE_ORDER)
    for (const state of ['queued','running','passed','failed'] as const)
      expect(summarize({ kind, state }).length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement `summarize`** with a per-kind table of state → sentence, pulling copy from `strings`.

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: templated plain-language block summaries"`

---

### Task 6: The event log

**Files:**
- Create: `src/engine/events.ts`
- Test: `tests/engine/events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EventType = 'run.created'|'run.started'|'run.completed'|'run.failed'|'run.cancelled'
    |'node.queued'|'node.started'|'node.step'|'node.completed'|'node.failed'|'node.skipped'|'node.waiting_approval'
  export type EventRow = { id: string; runId: string; nodeRunId: string | null; sequence: number; type: EventType; payload: unknown; createdAt: string }
  export async function appendEvent(input: { runId: string; nodeRunId?: string; type: EventType; payload?: unknown }): Promise<EventRow>
  export async function eventsSince(runId: string, afterSequence: number): Promise<EventRow[]>
  ```

`sequence` is allocated inside the same SQLite transaction as the insert, as `max(sequence)+1` scoped to `runId`.

- [ ] **Step 1: Write the failing test**

```ts
test('sequence is contiguous per run under concurrent appends', async () => {
  const runId = await newRun()
  await Promise.all(Array.from({length: 50}, (_, i) =>
    appendEvent({ runId, type: 'node.step', payload: { i } })))
  const seqs = (await eventsSince(runId, 0)).map(e => e.sequence)
  expect(seqs).toEqual(Array.from({length: 50}, (_, i) => i + 1))
})

// Review Focus 2
test('two runs keep independent sequences and never leak', async () => {
  const [a, b] = [await newRun(), await newRun()]
  await appendEvent({ runId: a, type: 'run.started' })
  await appendEvent({ runId: b, type: 'run.started' })
  await appendEvent({ runId: a, type: 'node.started' })
  expect((await eventsSince(a, 0)).map(e => e.sequence)).toEqual([1, 2])
  expect((await eventsSince(b, 0)).map(e => e.sequence)).toEqual([1])
  expect((await eventsSince(b, 0)).every(e => e.runId === b)).toBe(true)
})

test('eventsSince returns only what the client has not seen', async () => {
  const runId = await newRun()
  for (let i = 0; i < 5; i++) await appendEvent({ runId, type: 'node.step' })
  expect(await eventsSince(runId, 3)).toHaveLength(2)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement `src/engine/events.ts`** using `db.transaction` for the read-max-then-insert.

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: append-only event log with per-run sequence"`

---

### Task 7: Draft, publish and run creation

**Files:**
- Create: `src/engine/run.ts`, `src/app/api/workflows/[id]/draft/route.ts`, `src/app/api/workflows/[id]/publish/route.ts`, `src/app/api/workflows/[id]/runs/route.ts`
- Test: `tests/engine/run.test.ts`

**Interfaces:**
- Consumes: `validateGraph`, `defaultGraph` (Task 3); `appendEvent` (Task 6).
- Produces:
  ```ts
  export async function saveDraft(workflowId: string, graph: Graph): Promise<ValidationIssue[]>
  export async function publishVersion(workflowId: string): Promise<{ versionId: string; hash: string }>
  export async function createRun(input: { workflowId: string; request: string }): Promise<{ runId: string; versionId: string }>
  export async function cancelRun(runId: string): Promise<void>
  ```

`publishVersion` refuses to publish an invalid graph. `createRun` always binds to the **latest published version**, copying nothing from the draft.

- [ ] **Step 1: Write the failing test**

```ts
test('publishing an invalid graph is refused', async () => {
  await saveDraft(wf, { blocks: defaultGraph().blocks.filter(b => b.kind !== 'build') })
  await expect(publishVersion(wf)).rejects.toThrow(/missing_required_stage/)
})

test('the version hash changes only when the graph changes', async () => {
  const a = await publishVersion(wf)
  const b = await publishVersion(wf)
  expect(b.hash).toBe(a.hash)
})

// Review Focus 3
test('editing the draft does not alter a run already created', async () => {
  await publishVersion(wf)
  const { runId, versionId } = await createRun({ workflowId: wf, request: 'x' })
  await saveDraft(wf, addReviewer(defaultGraph()))
  await publishVersion(wf)
  const run = await getRun(runId)
  expect(run.versionId).toBe(versionId)
  expect(graphOf(run).blocks).toHaveLength(8)
})

test('creating a run emits run.created as sequence 1', async () => {
  const { runId } = await createRun({ workflowId: wf, request: 'x' })
  const [first] = await eventsSince(runId, 0)
  expect(first.type).toBe('run.created')
  expect(first.sequence).toBe(1)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement `src/engine/run.ts` and the three route handlers.** Hash is SHA-256 over the canonicalised graph JSON (keys sorted, positions excluded, so moving a block does not mint a version). Routes validate the body with Zod and return `400` with the `ValidationIssue[]`.

- [ ] **Step 4: Verify** — `npx vitest run tests/engine` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: draft save, version publish and run creation"`

---

### Task 8: The canvas, read-only

**Files:**
- Create: `src/ui/canvas/Canvas.tsx`, `src/ui/canvas/BlockCard.tsx`, `src/app/canvas/[workflowId]/page.tsx`
- Test: `tests/ui/BlockCard.test.tsx`

**Interfaces:**
- Consumes: `Graph`, `derivedEdges` (Task 3); `summarize` (Task 5); `theme`, `VisualState` (Task 1); `NodeState` (Task 4).
- Produces: `<Canvas graph={Graph} nodeRuns={NodeRunView[]} onSelect={(id) => void} expandedId={string | null} />`, where `NodeRunView = { blockId: string; state: NodeState; summary: string; steps: string[]; usage?: { tokens: number | null; costCents: number | null } }`; and `export function visualStateOf(state: NodeState): VisualState` in `BlockCard.tsx`.

`@xyflow/react` with one custom node type rendering `BlockCard`. Edges come from `derivedEdges`, `kind: 'return'` rendered as the red loop beneath the lane. Cards are ≥220px wide.

- [ ] **Step 1: Write the failing test**

```tsx
test('a collapsed card shows name and a result line, never a bare status', () => {
  render(<BlockCard block={buildBlock} view={{ state:'skipped', summary:'Not needed for this change' }} />)
  expect(screen.getByText('Not needed for this change')).toBeInTheDocument()
})

// Review Focus 5
test('unknown cost renders as not reported, never zero', () => {
  render(<BlockCard expanded block={buildBlock}
    view={{ state:'passed', summary:'Done', usage:{ tokens:null, costCents:null } }} />)
  expect(screen.getByText(/not reported/i)).toBeInTheDocument()
  expect(screen.queryByText('$0.00')).toBeNull()
})

test('state is conveyed by text as well as colour', () => {
  render(<BlockCard block={buildBlock} view={{ state:'failed', summary:'Stopped' }} />)
  expect(screen.getByLabelText(/failed/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement `BlockCard` and `Canvas`** and render the seeded workflow at `/canvas/[workflowId]`.

- [ ] **Step 4: Verify** — `npx vitest run tests/ui` → PASS; open the page and confirm the eight blocks render with cables.

- [ ] **Step 5: Commit** — `git commit -m "feat: canvas renders the template graph with result-bearing cards"`

---

### Task 9: Editing the template

**Files:**
- Modify: `src/ui/canvas/Canvas.tsx`
- Create: `src/ui/canvas/BlockInspector.tsx`
- Test: `tests/ui/editing.test.tsx`

**Interfaces:**
- Consumes: `saveDraft` (Task 7), `SINGLETON_KINDS` (Task 3).
- Produces: `<BlockInspector block={Block} onChange={(b: Block) => void} />`.

Add, remove, enable/disable, drag to reposition, and edit `label`/`config.model`. The block palette offers only kinds that are legal to add — a singleton already present is not offered.

- [ ] **Step 1: Write the failing test**

```tsx
test('the palette hides a singleton that already exists', () => {
  render(<Canvas graph={defaultGraph()} />)
  expect(within(screen.getByTestId('palette')).queryByText('Build')).toBeNull()
  expect(within(screen.getByTestId('palette')).getByText('Review')).toBeInTheDocument()
})

test('dragging a block persists its position without minting a version', async () => {
  const { hashBefore } = await publishAndHash()
  await dragBlock('build', { x: 40, y: 0 })
  await waitFor(() => expect(savedDraft().blocks.find(b=>b.kind==='build')!.position.x).toBe(40))
  expect((await publishVersion(wf)).hash).toBe(hashBefore)
})

test('disabling tests reconnects build to review on screen', async () => {
  render(<Canvas graph={defaultGraph()} />)
  await toggleBlock('tests')
  expect(renderedEdges()).toContain('build->review')
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement editing**, debouncing `saveDraft` at 500ms and surfacing returned `ValidationIssue[]` inline on the offending card.

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: edit the template on the canvas with live validation"`

---

### Task 10: In-place expansion

**Files:**
- Modify: `src/ui/canvas/BlockCard.tsx`, `src/ui/canvas/Canvas.tsx`
- Test: `tests/ui/expansion.test.tsx`

**Interfaces:**
- Produces: expanded `BlockCard` renders a breadcrumb (`Input › Build › Review`), the live step list, and the usage footer.

Expansion must not mutate stored positions: neighbours are pushed by a transient layout offset that is discarded on collapse.

- [ ] **Step 1: Write the failing test**

```tsx
test('an expanded card stays on the canvas and keeps its cables', () => {
  render(<Canvas graph={defaultGraph()} expandedId="build" />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByTestId('edge-build->review')).toBeInTheDocument()
})
test('an expanded card shows where it sits in the chain', () => {
  render(<Canvas graph={defaultGraph()} expandedId="review" />)
  expect(screen.getByTestId('breadcrumb')).toHaveTextContent('Input › Build › Review')
})
test('expanding does not rewrite stored positions', async () => {
  const before = savedDraft()
  await expandBlock('build')
  expect(savedDraft()).toEqual(before)
})
test('the live step list shows what the agent is doing now', () => {
  render(<BlockCard expanded block={buildBlock}
    view={{ state:'running', summary:'Working', steps:['Found the button','Changed the colour','Writing the spinner'] }} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement expansion** with the transient offset applied in `Canvas`'s node mapping only.

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: expand blocks in place with breadcrumb and live steps"`

---

### Task 11: The demo provider

**Files:**
- Create: `src/providers/types.ts`, `src/providers/demo.ts`
- Test: `tests/providers/demo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgentEvent = { type: 'step'; text: string } | { type: 'done'; summary: string } | { type: 'error'; message: string }
  export type AgentExecutionInput = { blockKind: BlockKind; request: string; seed?: string }
  export type ExecutionControls = { signal: AbortSignal }
  export interface AgentProvider {
    id: string
    isDemo: boolean
    execute(input: AgentExecutionInput, controls: ExecutionControls): AsyncIterable<AgentEvent>
    cancel?(providerRunId: string): Promise<void>
  }
  export const demoProvider: AgentProvider  // id: 'demo', isDemo: true
  ```

Deterministic: the same `seed` yields the same step sequence. A request containing `FAIL` yields an `error` event — this is how the failure path is demonstrated.

- [ ] **Step 1: Write the failing test**

```ts
test('the same seed produces the same steps', async () => {
  const a = await collect(demoProvider.execute({ blockKind:'build', request:'x', seed:'s1' }, ctl()))
  const b = await collect(demoProvider.execute({ blockKind:'build', request:'x', seed:'s1' }, ctl()))
  expect(a).toEqual(b)
})
test('a request marked FAIL ends in an error event', async () => {
  const out = await collect(demoProvider.execute({ blockKind:'build', request:'FAIL please' }, ctl()))
  expect(out.at(-1)).toMatchObject({ type:'error' })
})
test('aborting stops the stream', async () => {
  const c = new AbortController()
  const it = demoProvider.execute({ blockKind:'build', request:'x' }, { signal: c.signal })
  await it[Symbol.asyncIterator]().next()
  c.abort()
  await expect(collect(it)).resolves.toHaveLength(0)
})
test('the provider declares itself demo', () => {
  expect(demoProvider.isDemo).toBe(true)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement `demo.ts`** with a seeded PRNG and a per-`blockKind` script of step strings, yielding with a short delay between steps.

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: deterministic demo agent provider"`

---

### Task 12: The durable run

**Files:**
- Create: `src/engine/inngest/client.ts`, `src/engine/inngest/execute-run.ts`, `src/app/api/inngest/route.ts`, `src/app/api/runs/[runId]/cancel/route.ts`
- Test: `tests/engine/execute-run.test.ts`

**Interfaces:**
- Consumes: `createRun`, `cancelRun` (Task 7); `appendEvent` (Task 6); `demoProvider` (Task 11); `canTransition`, `rollUpRunStatus` (Task 4).
- Produces: `export const executeRun` — an Inngest function on event `factory/run.requested` with `{ runId: string }`.

Per node: one `step.run`, which emits `node.started`, streams `node.step` per provider step, then `node.completed` or `node.failed`. Bounded retries: `maxAttempts: 2` per node, recorded in `nodeRuns.attempt`. A `human` block emits `node.waiting_approval` and parks on `step.waitForEvent('factory/approval.decided')` with no timeout. Disabled blocks emit `node.skipped` with a reason.

**Node timeout:** each `step.run` races the provider against `config.timeoutMs ?? 600_000`; on expiry the node is `failed` with `failureCause: 'timeout'`.

- [ ] **Step 1: Write the failing test**

```ts
test('a demo run walks every enabled block and ends waiting on the human', async () => {
  const { runId } = await runToCompletion('add a spinner')
  const types = (await eventsSince(runId, 0)).map(e => e.type)
  expect(types).toContain('node.started')
  expect(types.at(-1)).toBe('node.waiting_approval')
})

test('a failing node is recorded as failed and never reported as success', async () => {
  const { runId } = await runToCompletion('FAIL please')
  const evts = await eventsSince(runId, 0)
  expect(evts.some(e => e.type === 'node.failed')).toBe(true)
  expect(evts.some(e => e.type === 'run.completed')).toBe(false)
  expect((await getNodeRun(runId, 'build')).failureCause).toMatch(/.+/)
})

test('retries are bounded and then the node stays failed', async () => {
  const { runId } = await runToCompletion('FAIL please')
  expect((await getNodeRun(runId, 'build')).attempt).toBe(2)
})

test('cancelling stops later nodes and persists the state', async () => {
  const { runId } = await startRun('slow')
  await cancelRun(runId)
  const states = await nodeStates(runId)
  expect(states.filter(s => s === 'running')).toHaveLength(0)
  expect(await runStatus(runId)).toBe('cancelled')
})

test('a disabled block is skipped with a reason, not silently dropped', async () => {
  const { runId } = await runWithDisabled('tests')
  const skip = (await eventsSince(runId, 0)).find(e => e.type === 'node.skipped')
  expect(skip!.payload).toMatchObject({ blockId: expect.any(String), reason: expect.any(String) })
})

// Review Focus 4
test('a provider that emits nothing times out instead of hanging', async () => {
  const { runId } = await runWithProvider(silentProvider, { timeoutMs: 50 })
  await waitFor(async () => expect(await runStatus(runId)).toBe('failed'))
  expect((await getNodeRun(runId, 'build')).failureCause).toBe('timeout')
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement the Inngest client, `executeRun` and the cancel route.** Cancellation is cooperative: `cancelRun` writes `runs.status = 'cancelled'`, the function checks it between nodes and aborts the in-flight provider via its `AbortSignal`.

- [ ] **Step 4: Verify**

Run: `npx inngest-cli dev` in one shell, then `npx vitest run tests/engine/execute-run.test.ts` — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: durable run execution with bounded retries, timeout and cancellation"`

---

### Task 13: Live event stream

**Files:**
- Create: `src/app/api/runs/[runId]/events/route.ts`, `src/ui/canvas/useRunStream.ts`
- Test: `tests/engine/sse.test.ts`, `tests/ui/useRunStream.test.ts`

**Interfaces:**
- Consumes: `eventsSince` (Task 6).
- Produces: `GET /api/runs/:runId/events?after=<sequence>` (SSE, each message `id: <sequence>`); `useRunStream(runId: string): { views: Record<string, NodeRunView>; lastSequence: number; connected: boolean }`.

On connect, the route replays everything after `?after=` before streaming live, so a reconnect is a replay.

- [ ] **Step 1: Write the failing test**

```ts
// Review Focus 1
test('reconnecting from the last sequence yields no gaps and no duplicates', async () => {
  const { runId } = await startRun('x')
  const first = await readSse(runId, 0, { closeAfter: 3 })
  const rest  = await readSse(runId, first.at(-1)!.sequence, { closeAfter: 5 })
  const all = [...first, ...rest].map(e => e.sequence)
  expect(new Set(all).size).toBe(all.length)
  expect(all).toEqual([...Array(all.length)].map((_, i) => i + 1))
})

test('events that arrived while disconnected are replayed on reconnect', async () => {
  const { runId } = await startRun('x')
  const seen = await readSse(runId, 0, { closeAfter: 2 })
  await appendEvent({ runId, type: 'node.step', payload: { text: 'missed' } })
  const after = await readSse(runId, seen.at(-1)!.sequence, { closeAfter: 1 })
  expect(after[0].payload).toMatchObject({ text: 'missed' })
})

test('useRunStream folds events into one view per block', async () => {
  const { result } = renderHook(() => useRunStream(runId))
  await waitFor(() => expect(result.current.views['build'].state).toBe('running'))
  expect(result.current.views['build'].steps.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement the route and the hook.** The hook stores `lastSequence` and reconnects with it on `error`, backing off 1s/2s/5s.

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: SSE event stream with resume and client folding"`

---

### Task 14: The canvas comes alive

**Files:**
- Modify: `src/ui/canvas/Canvas.tsx`, `src/app/canvas/[workflowId]/page.tsx`
- Create: `src/ui/EventBar.tsx`
- Test: `tests/ui/live.test.tsx`

**Interfaces:**
- Consumes: `useRunStream` (Task 13); `summarize` (Task 5).
- Produces: `<EventBar event={EventRow} block={Block} onPoint={(blockId: string) => void} />`.

Run / Cancel in the header. A visible **Demo** badge whenever `run.providerId === 'demo'`.

- [ ] **Step 1: Write the failing test**

```tsx
test('a node lights up only when an event says so', async () => {
  render(<CanvasPage runId={runId} />)
  expect(screen.getByTestId('node-build')).toHaveAttribute('data-state', 'queued')
  await emit({ type:'node.started', nodeRunId:'build' })
  await waitFor(() => expect(screen.getByTestId('node-build')).toHaveAttribute('data-state','running'))
})

test('every event line names its block and can point at it', async () => {
  render(<CanvasPage runId={runId} />)
  await emit({ type:'node.failed', nodeRunId:'review', payload:{ cause:'x' } })
  const bar = screen.getByTestId('event-bar')
  expect(within(bar).getByText('Review')).toBeInTheDocument()
  await userEvent.click(within(bar).getByRole('button', { name:/point it out/i }))
  expect(screen.getByTestId('node-review')).toHaveAttribute('data-highlighted','true')
})

test('a demo run is labelled demo', async () => {
  render(<CanvasPage runId={demoRunId} />)
  expect(screen.getByText('Demo')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement the live binding, the event bar and the Run/Cancel controls.**

- [ ] **Step 4: Verify** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: live canvas bound to the event stream with an anchored event bar"`

---

### Task 15: Depth and motion (2.5D)

**Files:**
- Create: `src/ui/canvas/Depth.tsx`, `src/ui/canvas/FlowParticles.tsx`
- Modify: `src/ui/canvas/Canvas.tsx`, `src/ui/theme.ts`
- Test: `tests/ui/depth.test.tsx`

**Interfaces:**
- Consumes: `theme` (Task 1), `derivedEdges` (Task 3), `useRunStream` (Task 13).
- Produces: `<Depth />` (fixed perspective-grid floor + ambient glow layer, `aria-hidden`, `pointer-events: none`); `<FlowParticles edge={Edge} active={boolean} />` (SVG dots animated along the edge path via `<animateMotion>`).

This is the depth the design doc calls for on the main canvas: perspective floor, layered glow, card elevation on hover, parallax on pan, and particles travelling a cable while its target block is running. It is CSS and SVG only — **no 3D engine here**. The true 3D Hangar is a separate surface, deferred to M5.

- [ ] **Step 1: Write the failing test**

```tsx
test('particles run only on cables feeding a running block', () => {
  render(<Canvas graph={defaultGraph()} nodeRuns={[{ blockId:'build', state:'running' }]} />)
  expect(screen.getByTestId('particles-plan->build')).toBeInTheDocument()
  expect(screen.queryByTestId('particles-build->review')).toBeNull()
})

test('the depth layer is decorative and never captures clicks', () => {
  render(<Canvas graph={defaultGraph()} />)
  const floor = screen.getByTestId('depth-floor')
  expect(floor).toHaveAttribute('aria-hidden', 'true')
  expect(getComputedStyle(floor).pointerEvents).toBe('none')
})

test('motion is dropped when the user asks for reduced motion', () => {
  matchMediaMock('(prefers-reduced-motion: reduce)', true)
  render(<Canvas graph={defaultGraph()} nodeRuns={[{ blockId:'build', state:'running' }]} />)
  expect(screen.queryByTestId('particles-plan->build')).toBeNull()
  expect(screen.getByTestId('node-build')).toHaveAttribute('data-state', 'running')
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement `Depth` and `FlowParticles`**, add `theme.elevation(level)` for hover shadow, and apply a parallax translate to the floor from the xyflow viewport transform at roughly 0.3× the pan.

- [ ] **Step 4: Verify** — `npx vitest run tests/ui/depth.test.tsx` → PASS; pan the canvas and confirm the floor trails the nodes.

- [ ] **Step 5: Commit** — `git commit -m "feat: 2.5D depth, parallax floor and flow particles on active cables"`

---

### Task 16: End-to-end

**Files:**
- Create: `e2e/vertical-slice.spec.ts`, `playwright.config.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing test**

```ts
test('design, run, fail, cancel, reload', async ({ page }) => {
  await page.goto('/canvas/demo')
  await page.getByTestId('block-tests').getByRole('button', { name:'Disable' }).click()
  await page.getByRole('button', { name:'Run' }).click()
  await expect(page.getByTestId('node-build')).toHaveAttribute('data-state','running')
  await expect(page.getByTestId('node-tests')).toHaveAttribute('data-state','skipped')
  await expect(page.getByTestId('node-human')).toHaveAttribute('data-state','waiting_approval', { timeout: 30_000 })
  await page.reload()
  await expect(page.getByTestId('node-human')).toHaveAttribute('data-state','waiting_approval')
})
```

- [ ] **Step 2: Run and watch it fail.** `npx playwright test`

- [ ] **Step 3: Make it pass** and write the README: prerequisites, `npm install`, `npm run db:migrate`, `npm run seed`, `npx inngest-cli dev`, `npm run dev`, how to run each test suite, and an explicit note that **all execution in M0–M2 is Demo**.

- [ ] **Step 4: Verify** — `npx vitest run && npx playwright test && npx tsc --noEmit && npm run lint && npm run build` all pass.

- [ ] **Step 5: Commit** — `git commit -m "test: end-to-end vertical slice and README"`

---

## Not in this plan

Deferred to later plans, in this order: the real `claude` adapter with worktrees, Runtape hook ingestion and ContextForge injection (M3); the planner, reviewers, Approver and the return loop (M4); Business/Dev toggle, macOS notifications and the 3D Hangar (M5); GitHub App and webhooks (M6).

# Brief: visual redesign of the AI Factory canvas

Hand this whole file to the model doing the work. It is the brief, not a summary of one.

---

## 0. What you are working on

**AI Factory** is a live monitor for AI coding agents. A run is a fixed left-to-right flow of
blocks — Input → Plan → Build → Tests → Review → Approve → Human check → Ship — and the canvas
shows, in real time, what each block is doing, what it produced, and where a failure stopped the
flow. It is an editor and a monitor on the same surface. Two kinds of people have to read it: the
developer who ran it, and the non-programmer who is paying for the result.

Everything that executes today is a **simulated (Demo) provider**. No real agent is wired in yet.

The product's single reason to exist is **honesty about provenance**: a sentence an AI wrote and a
test that actually passed must never look the same. The current UI enforces that correctly. Your
redesign must keep enforcing it. This constrains colour, weight and emphasis — it is not decoration
you can simplify away.

**Your job: make this screen look as good as it deserves to.** Visual craft only. No new features,
no behaviour changes, no copy changes, no data-model changes.

## 1. Where the visual code lives

| File | Lines | What it is |
| --- | --- | --- |
| `src/ui/theme.ts` | 45 | The whole visual vocabulary: colours, `glow(state)`, `elevation(level)`, `ambient`. Leaf module, imports nothing. |
| `src/ui/canvas/BlockCard.tsx` | 222 | The card. `BlockCard` (in a run) and `NotInRunCard` (added after the run started). Collapsed 240px / expanded 320px. |
| `src/ui/canvas/Canvas.tsx` | 448 | The xyflow canvas: node wrapper, cable/edge styling, left sidebar (palette + inspector), parallax. |
| `src/ui/canvas/CanvasScreen.tsx` | 149 | Header: request field, Run/Cancel, Demo badge, run status. |
| `src/ui/canvas/Depth.tsx` | 48 | Decorative floor: perspective grid + ambient glow. `aria-hidden`, never takes a click. |
| `src/ui/canvas/FlowParticles.tsx` | 65 | Dots travelling a cable while the target block is running. |
| `src/ui/canvas/BlockInspector.tsx` | 70 | Name / model / enabled form in the sidebar. |
| `src/ui/EventBar.tsx` | 101 | Bottom log: one line per event, each naming its block, with a "Point it out" button. |
| `src/ui/strings.ts` | ~200 | **All** user-facing copy. Read it to know what text you are laying out. Do not change a single string. |
| `src/app/globals.css` | 10 | Tailwind import + two CSS variables. Almost empty — the components use inline styles. |

Everything is inline `style={{}}`. Tailwind 4 is installed but barely used. You may move to CSS
modules, a `globals.css` layer with custom properties, or Tailwind — pick one and be consistent, and
say in your report why. If you move colours out of `theme.ts`, keep `theme.ts` as the single source
of truth and have the CSS read from it (or generate the variables from it); two places defining
`#3b82f6` is how the state colour silently breaks.

Stack: Next.js 16, React 19, TypeScript strict, `@xyflow/react` 12, Tailwind 4, Vitest + Testing
Library, Playwright.

## 2. The settled visual language — this is the target, not a suggestion

From `docs/superpowers/specs/2026-11-10-ai-factory-design.md` §6, derived from reference images the
author chose. Treat it as the brief's taste, and raise the execution to meet it:

- Dark near-black background, subtle perspective grid, restrained ambient glow.
- Rounded cards, thin borders. **Glow only on what matters**: blue running, red failed, amber
  waiting on a human. Everything else is quiet. A screen where everything glows says nothing.
- **Circular badges on the card corner**: blue ✓ for done, red ✗ for failed.
- **The model is written inside the block** (`✳ Opus`, `◎ Sol`). Model-per-job is a selling point
  and must be legible, not a grey afterthought.
- **Orthogonal (right-angle) cables with junction dots.** The path of a failure is red and can be
  traced by eye from where it was produced to where it stopped the flow.
- Cards are **wide** — text must not wrap mid-phrase.
- **Density is a hard constraint. When in doubt, remove.** The author rejected two earlier
  iterations purely for visual density. A screen that needs study before it can be read is a failed
  screen.

Four of those are **not implemented yet**, and they are the biggest wins available to you:

1. Cables are xyflow default béziers. The design asks for orthogonal paths with junction dots.
2. There are no corner status badges — state is a text label only.
3. The model renders as plain grey 12px text with no glyph and no chip.
4. Cards are 240px and the copy does wrap mid-phrase at that width. Widening changes layout maths —
   see the test in §4.

## 3. Hard invariants — breaking any of these breaks the product

1. **Provenance stays visible.** A summary an AI wrote is prefixed `AI says:` (italic, amber,
   `title=` explaining it is unverified). Evidence-backed sentences carry no marker. Both the card
   and the event bar do this. You may restyle the marker; you may not make it quiet, and you may not
   change its text.
2. **The Demo badge stays obvious** while the provider is `demo`. A simulated run being mistaken for
   a real one is the product's worst failure mode.
3. **No light without an event.** Never animate, pulse or glow on a timer. Every moving thing must be
   driven by real run state. Decorative ambient light on the floor is fine; a card that breathes
   while nothing is happening is a lie.
4. **State is never colour alone.** Every card keeps its text state label and its
   `aria-label="State: …"`. The colour is redundant reinforcement, not the carrier.
5. **`prefers-reduced-motion` kills motion**, including particles and hover lift, and the screen must
   still say everything it said with motion. `useReducedMotion()` already exists — use it.
6. **The state colour survives selection.** The left edge of the card carries the state colour via
   `borderLeftWidth`/`borderLeftColor` longhand. A `border` or `borderColor` shorthand added later
   silently repaints it — this bug shipped twice and has two regression tests. Whatever technique
   you use, selection and state must not be able to overwrite each other.
7. **Every message names its block.** No orphan errors, no floating toast, nothing outside the
   canvas. Validation issues render on the card they belong to.
8. **`NotInRunCard` has no state at all** — not even a quiet one. The run never heard of that block,
   so nothing on it may come from the run. It stays visually distinct (currently dashed).
9. **Cost and tokens that were not reported say "Not reported", never `0`** and never nothing.
10. **Copy is frozen.** Every string comes from `src/ui/strings.ts`. Changing wording is a product
    decision and not part of this task.

## 4. The test suite is load-bearing. 282 tests pass today. Keep them passing.

Run `npx vitest run` after every step. These are the ones that pin visual behaviour:

- `tests/ui/BlockCard.test.tsx` — card contents per state, the `AI says` marker, usage rendering,
  and: `expect(LANE_SPACING - CARD_WIDTH).toBeGreaterThanOrEqual(80)`. **If you widen the card you
  must raise `LANE_SPACING` in `src/domain/graph.ts` to keep ≥80px of clear space between card
  edges.** That test exists because a layout once rendered as a solid bar with no visible cables.
  Widening the card without touching lane spacing reproduces exactly that.
- `tests/ui/expansion.test.tsx` — in-place expansion, the transient layout offset, and
  *"selecting a card keeps its state colour and logs no React style error"* (asserts
  `borderLeftColor` is unchanged and `borderLeftWidth === '4px'`, and spies on `console.error`).
- `tests/ui/depth.test.tsx` — particles exist only on a cable feeding a genuinely running block;
  the floor is `aria-hidden` and `pointer-events: none`; reduced motion drops motion but keeps
  meaning.
- `tests/ui/failure.test.tsx`, `tests/ui/run-presentation.test.tsx`, `tests/ui/live.test.tsx` —
  what a failed/live/draft card is allowed to say.
- `tests/ui/theme.test.ts` — every state has a colour and a glow.
- `e2e/vertical-slice.spec.ts` — a real run end to end, including measuring that each particle sits
  within a few screen pixels of the actual cable path. **If you change cable geometry, this is the
  test that will catch you.**

A test that exists to pin a *pixel* value you are deliberately changing (card width, border width)
may be updated — say so explicitly in your report and keep the intent. A test that pins *behaviour*
(provenance, reduced motion, no-fake-activity, state-colour survival) may not be weakened. If a
behavioural test fails, the redesign is wrong, not the test.

Also keep green: `npx tsc --noEmit`, `npm run lint`, `npm run build`.

## 5. You must look at it in a browser. This is not optional.

A previous iteration of this canvas passed **85 tests** while rendering as a solid bar with no
visible cables at all. jsdom cannot see layout. Any claim about appearance that is not backed by a
screenshot you took is not a claim, it is a guess.

```bash
npm install
rm -rf .factory/factory.db*     # a stale db keeps old block positions and fakes a broken layout
npm run db:migrate
npm run seed                    # the demo workflow id is "demo"
npx inngest-cli dev             # second terminal — runs will not execute without it
npm run dev                     # third terminal
# open http://localhost:3000/canvas/demo
```

Type any request and press **Run** to watch the real sequence. Put the word `FAIL` in the request to
get a simulated failure, which is how you see red states and the return cable. Turn a block off in
the sidebar to see the skipped and disabled treatments. If `npx inngest-cli dev` cannot be
downloaded on your network, say so plainly in your report — everything except executing a run still
works, and you can render states directly with Testing Library plus a Playwright screenshot instead.

**Deliver screenshots of all of these**, before and after:

1. Idle canvas, nothing run yet (every block queued).
2. A run mid-flight: one block running, earlier ones passed, particles on the live cable.
3. A failure: red card, red return cable, the event bar showing where it came from.
4. `waiting_approval` on the Human check — the state the whole product is built around.
5. A card expanded, with steps and token/cost rows.
6. One card showing an `AI says:` summary next to one showing an evidence-backed summary, so the
   difference is checkable at a glance.
7. The same canvas at 1280px wide and at 1920px.

## 6. How to proceed

**Phase 0 — show two directions before you write product code.** Build a throwaway static HTML page
(real strings from `strings.ts`, real block names, all five states side by side) presenting **two
genuinely different** interpretations of §2 — not one design and a tinted variant. Name the trade-off
each one makes. Stop and let the author choose. Do not skip this: taste is the author's call, and the
density constraint has already killed two iterations.

**Phase 1 — build the chosen direction** in small commits, in this order, running the tests after
each: `theme.ts` tokens → `BlockCard` → cables and `Depth` → header and `EventBar` → sidebar. A
commit that touches all five at once cannot be reviewed or reverted.

**Phase 2 — report.** What you changed and why, the before/after screenshots, the test and
typecheck/lint/build output, every test you modified with the reason, and anything in §2 you could
not reach and why.

## 7. Do not

- Add a 3D engine. The main canvas is deliberately 2.5D — real 3D here means overlapping nodes,
  distorted text, and state you must move a camera to read. (A separate 3D "Hangar" overview surface
  is designed and deferred; it is not this task.)
- Add a runtime dependency without proposing it first and saying what it costs.
- Replace `@xyflow/react`.
- Touch anything in `src/db/`, `src/engine/`, `src/domain/` (except `LANE_SPACING`), `src/providers/`
  or `src/app/api/`.
- Change any string, any `data-testid`, or any `aria-label`.
- Invent a number, a count, a cost or a state that the data does not contain.
- Make it busy. Rich is not the same as crowded. The best move available to you is often removal.

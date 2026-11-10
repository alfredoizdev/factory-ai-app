# AI Factory

Design a flow of blocks on a canvas and watch AI coding agents run it, live.

> **Everything that executes in this milestone (M0 to M2) is Demo.** No real agent is wired in. A simulated
> provider produces the steps, and the canvas says so with a **Demo** badge next to the run. Nothing
> you see running has changed any code.

## Prerequisites

- Node.js 20 or newer
- npm

## Run it

```bash
npm install
npm run db:migrate     # creates .factory/factory.db
npm run seed           # adds the demo project; its workflow id is "demo"
npx inngest-cli dev    # in a second terminal, see "Pressing Run needs Inngest" below
npm run dev            # in a third terminal
```

Open <http://localhost:3000/canvas/demo>.

`npm run dev` sets `INNGEST_DEV=1` for you. Without it the Inngest SDK looks for a cloud event key and
starting a run fails with "The run could not be started."

## Pressing Run needs the Inngest dev server

Runs execute as durable functions behind Inngest. If `npx inngest-cli dev` is not running, pressing **Run**
shows "The run could not be started. Nothing ran.", or, if Inngest is down only partway, creates a run that
never executes.

If you cannot start Inngest (the CLI is downloaded on first use and that download can be blocked on
restricted networks), you can still use everything except executing a run:

- Works without Inngest: the canvas, adding, renaming, disabling and removing blocks, validation, draft
  autosave, reloading, the database, and all unit and component tests.
- Needs Inngest: starting a run, and therefore watching one, cancelling one, and the end-to-end test.

If Inngest runs on a different app port than 3000, tell it where the app is:
`npx inngest-cli dev -u http://localhost:<port>/api/inngest`.

## If the canvas looks wrong, reset the database

`.factory/factory.db` keeps the draft it already has, and `npm run seed` **skips** a demo workflow that
already exists. If you set up the app with an older version, you will keep seeing the old block positions
(overlapping cards, invisible cables) even though the code is fixed. Reset it:

```bash
rm .factory/factory.db*
npm run db:migrate
npm run seed
```

## Tests

| Command | What it covers |
| --- | --- |
| `npx vitest run` | Unit and component tests (domain, database, engine, providers, UI). No browser, no Inngest. |
| `npx tsc --noEmit` | Type check. |
| `npm run lint` | Lint. |
| `npm run build` | Production build. |
| `npx playwright test` | The end-to-end test, described below. |

### End-to-end

`e2e/vertical-slice.spec.ts` walks the real path: it turns the Tests block off, runs the flow, and checks that
Build runs, Tests is skipped and the flow stops at the Human check, then reloads and checks it is still there.
Stopping at the Human check is the correct end state for this milestone: there is no approval endpoint yet.

Before running it:

1. Install the browser once: `npx playwright install chromium` (a download; it needs network access).
2. Start Inngest pointed at the test server's port: `npx inngest-cli dev -u http://localhost:3100/api/inngest`.
3. Run `npx playwright test`.

The test starts its own Next dev server on port 3100 with a throwaway database in `e2e/.tmp/` and its own
build folder (`.next-e2e`), so it never touches `.factory/factory.db` and can run beside your own `npm run dev`.
It does not start Inngest for you.

If the browser cannot be downloaded or Inngest cannot be started, the test cannot run in that environment.
It is not skipped silently: it fails at browser launch or at pressing Run.

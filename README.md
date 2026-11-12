# AI Factory

Design a flow of blocks on a canvas and watch AI coding agents run it, live.

> **Everything that executes in this milestone (M0 to M2) is Demo.** No real agent is wired in. A simulated
> provider produces the steps, and the canvas says so with a **Demo** badge next to the run. Nothing
> you see running has changed any code.

## Prerequisites

- Node.js 20 or newer
- npm
- Docker Desktop, running (for the local test database)

## Run it

```bash
npm install
npm run dev            # starts the local test database, Inngest and the app, all in one terminal
```

## Two databases: test data and real data

| Command | Database | Pictures | Use it for |
| --- | --- | --- | --- |
| `npm run dev` | Postgres 17 in Docker, on this computer (`docker-compose.yml`, port 54410) | Local files | Building and trying changes. The top bar shows **Test data**. |
| `npm run dev:neon` | Neon (keys in `.env.local`) | Cloudflare R2 | The real tasks, shared between computers. |

Both are the same Postgres, so what works locally works on Neon. A change to the tables is made once
(`npm run db:generate`), tried locally (`npm run dev` applies it), and then applied to Neon with
`npm run db:migrate:neon`. Only the structure travels; the data of each database stays where it is.

`npm run db:local:stop` stops the local database; its data is kept in a Docker volume. Do not switch commands
while a task is running: its steps would be written to the other database.

Open <http://127.0.0.1:4100/canvas/demo>.

**Port 4100, on this computer only.** The app and Inngest both listen on 127.0.0.1, so nothing on your network
can reach them: an unattended agent sits behind the Run button. The app has its own port so it never shares one
with another project's `next dev` (which usually takes 3000). Use the `127.0.0.1` address rather than
`localhost`: some browsers try IPv6 first, and a different server listening there would answer instead.

`npm run dev` sets `INNGEST_DEV` to the local Inngest address for you. Without it the Inngest SDK looks for a cloud event key and
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

`npm run inngest` already points Inngest at the app on port 4100 and keeps it on 127.0.0.1. Started by hand,
the equivalent is `npx inngest-cli dev --host 127.0.0.1 -u http://127.0.0.1:4100/api/inngest`.

## Start the test data over

This erases the local test database only, never Neon:

```bash
docker compose down -v
npm run dev
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
It also slows the Demo agent (`FACTORY_DEMO_STEP_DELAY_MS=600`) so a block stays running long enough to be watched, and it checks
that the flow particles sit on the real cable (within 2px) and move along it. Set that variable yourself to watch a Demo run in slow motion.

If the browser cannot be downloaded or Inngest cannot be started, the test cannot run in that environment.
It is not skipped silently: it fails at browser launch or at pressing Run.

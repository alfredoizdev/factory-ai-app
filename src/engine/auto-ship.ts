import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { events, runs } from '@/db/schema'
import { shipsOnItsOwn, type AskMode } from '@/domain/ask-mode'
import type { AskModel } from '@/engine/branch-name'
import { defaultBranch } from '@/engine/branches'
import { autoShipRecord, changedFiles, DeliveryError, deliveryState, keepOnBranch, pushBranch, type AutoShip } from '@/engine/delivery'
import { keepOptionsFor } from '@/engine/delivery-options'
import { appendEvent } from '@/engine/events'
import { projectHere } from '@/engine/machine'
import { humanCheckPassedBy } from '@/engine/passed-check'
import { clip, redact } from '@/engine/redact'
import { gitHubConnectionProblem, openPullRequest, ShipError, type Gh } from '@/engine/ship'
import { DEMO_PROVIDER_ID } from '@/providers/ids'
import { strings } from '@/ui/strings'

// After a change passed (on its own, or by the person's yes) in "only what matters": the same keep, send and open the
// buttons do, in the same order, each its own durable step. It never merges. Anything missing or refused ends softly:
// one record saying where it stopped and why, the change still kept, the run still completed, nothing retried in a loop.
// Each step is safe to run twice: keep returns once kept, a branch already sent is not sent again (and a push is never
// forced), and open reuses the pull request already recorded.

/** `gh`: absent, the real one. `ask`: the model that names the branch and the commit; absent, no model is asked. */
export type AutoShipDeps = { gh?: Gh; ask?: AskModel }
export type AutoStep = { ok: true } | { ok: false }

type Step = NonNullable<AutoShip['step']>

const latest = autoShipRecord

const record = (runId: string, payload: AutoShip) => appendEvent({ runId, type: 'run.auto_ship', payload })

/** Only a refusal the app can say is a soft stop; anything else is thrown, and the step is tried again. */
async function softly(runId: string, step: Step, work: () => Promise<void>): Promise<AutoStep> {
  try {
    await work()
    return { ok: true }
  } catch (e) {
    if (!(e instanceof DeliveryError) && !(e instanceof ShipError)) throw e
    await stop(runId, step, e.kind === 'no_connection' ? 'no_connection' : 'failed', e.message)
    return { ok: false }
  }
}

async function stop(runId: string, step: Step, reason: 'no_connection' | 'failed', message: string): Promise<void> {
  // The last step before the browser gets it: cleaned here too, whatever a caller already did.
  await record(runId, { state: 'stopped', step, reason, message: clip(redact(message).replace(/[a-z]+:\/\/[^\s]*@/gi, ''), 300) })
}

/**
 * Whether the change is kept, sent and opened on its own: a finished real run whose human check passed, in "only what
 * matters" without "stop for me" (the mode as the run read it when it started), and not already stopped or opened.
 */
export async function shouldShipOnItsOwn(runId: string, mode: AskMode, stopForMe: boolean): Promise<boolean> {
  if (!shipsOnItsOwn(mode, stopForMe)) return false
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  if (!run || run.status !== 'completed' || run.providerId === DEMO_PROVIDER_ID) return false
  if ((await humanCheckPassedBy(runId)) === null) return false
  // A run that changed nothing has nothing to keep or send: it is not tried, rather than said to have failed.
  if ((await changedFiles(runId)).length === 0) return false
  const last = await latest(runId)
  return last?.state !== 'stopped' && last?.state !== 'opened'
}

/** Says it started (once), then keeps the change on its own branch, named and described as the Save button does. */
export async function autoKeep(runId: string, deps: AutoShipDeps = {}): Promise<AutoStep> {
  if (!(await latest(runId))) await record(runId, { state: 'started', step: null, reason: null, message: null })
  return softly(runId, 'keep', async () => {
    if ((await deliveryState(runId)).kept) return
    await keepOnBranch(runId, await keepOptionsFor(runId, '', deps.ask ?? noModel))
  })
}

/**
 * Sends the kept branch, that branch only and never forced, to origin. A branch already sent is not sent again. Nothing
 * is sent unless the whole way to a pull request is there first: an origin on GitHub, and gh installed and signed in.
 */
export async function autoSend(runId: string, deps: AutoShipDeps = {}): Promise<AutoStep> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)))[0]
  const repo = run ? ((await projectHere(run.projectId))?.repoPath ?? null) : null
  const state = await deliveryState(runId)
  if (state.kept && state.pushed) return { ok: true }
  // The project's own main branch is never sent on its own.
  if (repo && state.branch && state.branch === defaultBranch(repo)) {
    await stop(runId, 'send', 'failed', strings.delivery.auto.mainBranch)
    return { ok: false }
  }
  return softly(runId, 'send', async () => {
    const missing = repo ? await gitHubConnectionProblem(repo, deps.gh) : null
    if (missing) throw missing
    await pushBranch(runId)
  })
}

/** Opens the pull request into the main branch, or reuses the one recorded, and says it is open. Never merges. */
export async function autoOpen(runId: string, deps: AutoShipDeps = {}): Promise<AutoStep> {
  try {
    await openPullRequest(runId, deps.gh)
  } catch (e) {
    if (!(e instanceof DeliveryError) && !(e instanceof ShipError)) throw e
    // Opened and recorded, and only reading it back afterwards failed: it is open.
    if (!(await prRecorded(runId))) {
      await stop(runId, 'open', e.kind === 'no_connection' ? 'no_connection' : 'failed', e.message)
      return { ok: false }
    }
  }
  if ((await latest(runId))?.state !== 'opened') await record(runId, { state: 'opened', step: null, reason: null, message: null })
  return { ok: true }
}

async function prRecorded(runId: string): Promise<boolean> {
  return (await db.select({ id: events.id }).from(events).where(and(eq(events.runId, runId), eq(events.type, 'run.pr_opened'))).limit(1)).length > 0
}

/**
 * When a step kept failing until the run gave up: a start with no ending is ended, at the step it got to, so the card
 * never says it is still sending. A pull request already recorded is open, whatever failed after it: it is said to be
 * open. Nothing else changes; the run keeps its status.
 */
export async function endAutoShipAfterError(runId: string): Promise<void> {
  if ((await latest(runId))?.state !== 'started') return
  if (await prRecorded(runId)) {
    await record(runId, { state: 'opened', step: null, reason: null, message: null })
    return
  }
  const state = await deliveryState(runId)
  await stop(runId, !state.kept ? 'keep' : !state.pushed ? 'send' : 'open', 'failed', strings.run.internalFailure)
}

/** Without a model the branch and the commit are named from the request's own words. */
const noModel: AskModel = async () => {
  throw new Error('no model')
}

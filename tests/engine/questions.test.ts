import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { events, nodeRuns, projectNotes, projects, questions, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { askPerson, answerQuestion, consumeAnswer, decisionText, LEAVE, openQuestion, OTHER, QuestionError, takeAnswer, type Question } from '@/engine/questions'
import { recordFindings } from '@/engine/findings'
import { deliverPending, relayTick, markWaiting, seedWaiting, RESEND_AFTER_MS } from '@/engine/relay'
import { cancelRun, createRun, publishVersion, saveDraft } from '@/engine/run'
import { POST } from '@/app/api/runs/[runId]/questions/[questionId]/route'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

/** A run whose human block is running, as when the review has something to ask. */
async function runningRun(): Promise<{ projectId: string; runId: string; nodeRunId: string }> {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'r' })
  await db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId))
  const node = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'human')!
  await db.update(nodeRuns).set({ state: 'running' }).where(eq(nodeRuns.id, node.id))
  return { projectId, runId, nodeRunId: node.id }
}

const opts = [
  { id: 'a', label: 'Use the old way', means: 'Keeps what was there.' },
  { id: 'b', label: 'Use the new way', means: 'Changes it.' },
]
const ask = (over: Partial<Parameters<typeof askPerson>[2]> = {}) => ({
  findingId: null, kind: 'finding' as const, text: 'Which way?', why: 'Both are possible.', options: opts, recommended: 'a', touches: [], ...over,
})
const sent: { name: string; data: Record<string, unknown> }[] = []
const deps = { send: async (e: { name: string; data: Record<string, unknown> }) => void sent.push(e), actor: () => 'tester, at this computer' }
const entries = async (projectId: string) => (await db.select().from(projectNotes).where(eq(projectNotes.projectId, projectId))).filter(n => n.kind === 'decision')
const status = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.status
const lastEvent = async (runId: string) => (await db.select().from(events).where(eq(events.runId, runId))).sort((a, b) => a.sequence - b.sequence).at(-1)!.type
const failsWith = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e).toBeInstanceOf(QuestionError)
  expect((e as QuestionError).status).toBe(status)
  expect((e as QuestionError).message).toBe(message)
}

describe('asking', () => {
  test('parks the run on the question', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    expect(await status(runId)).toBe('waiting_approval')
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!.state).toBe('waiting_approval')
    expect(await lastEvent(runId)).toBe('node.question_asked')
    expect(q).toMatchObject({ runId, nodeRunId, state: 'open', recommended: 'a', answerOption: null })
    expect((await openQuestion(runId))!.id).toBe(q.id)
    expect(await takeAnswer(q.id)).toBeNull()
  })

  test('the detail is trimmed and capped; without one it is null', async () => {
    const a = await runningRun()
    expect((await askPerson(a.runId, a.nodeRunId, ask())).detail).toBeNull()
    const b = await runningRun()
    const q = await askPerson(b.runId, b.nodeRunId, { ...ask(), detail: `  ${'x'.repeat(2000)}  ` })
    expect(q.detail).toHaveLength(1000)
    expect((await openQuestion(b.runId))!.detail).toHaveLength(1000)
  })

  test('the option to leave it comes last, and other is never listed', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    expect(q.options.map(o => o.id)).toEqual(['a', 'b', LEAVE])
    expect(q.options.at(-1)).toEqual({ id: LEAVE, label: strings.question.leaveLabel, means: strings.question.leaveMeans })
    expect(q.options.some(o => o.id === OTHER)).toBe(false)
  })

  test('refuses a question that cannot be answered sensibly', async () => {
    const { runId, nodeRunId } = await runningRun()
    const dup = { id: 'a', label: 'x', means: 'y' }
    await expect(askPerson(runId, nodeRunId, ask({ options: [dup, dup] }))).rejects.toThrow()
    await expect(askPerson(runId, nodeRunId, ask({ options: [{ id: OTHER, label: 'x', means: 'y' }] }))).rejects.toThrow()
    await expect(askPerson(runId, nodeRunId, ask({ options: [] }))).rejects.toThrow()
    await expect(askPerson(runId, nodeRunId, ask({ recommended: 'zzz' }))).rejects.toThrow()
    expect(await status(runId)).toBe('running')
    expect(await openQuestion(runId)).toBeNull()
  })

  test('long words are trimmed, then capped', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask({ text: `  ${'t'.repeat(5000)}  `, why: 'w'.repeat(5000), options: [{ id: 'a', label: 'l'.repeat(500), means: 'm'.repeat(5000) }], recommended: null }))
    expect(q.text.length).toBeLessThanOrEqual(500)
    expect(q.text.startsWith('t')).toBe(true)
    expect(q.why.length).toBeLessThanOrEqual(1000)
    expect(q.options[0]!.label.length).toBeLessThanOrEqual(80)
    expect(q.options[0]!.means.length).toBeLessThanOrEqual(300)
  })

  test('asking the same question again returns it; a different one while it is open is refused', async () => {
    const { runId, nodeRunId } = await runningRun()
    const first = await askPerson(runId, nodeRunId, ask({ findingId: 'f1' }))
    const again = await askPerson(runId, nodeRunId, ask({ findingId: 'f1' }))
    expect(again.id).toBe(first.id)
    expect(await db.select().from(questions).where(eq(questions.runId, runId))).toHaveLength(1)
    await expect(askPerson(runId, nodeRunId, ask({ findingId: 'f2' }))).rejects.toThrow()
    expect(await db.select().from(questions).where(eq(questions.runId, runId))).toHaveLength(1)
  })
})

describe('asking again', () => {
  test('after the answer, the same question comes back as it was: no second row, no new events, the run goes on', async () => {
    const { runId, nodeRunId } = await runningRun()
    const first = await askPerson(runId, nodeRunId, ask({ findingId: 'f9' }))
    await answerQuestion(first.id, { option: 'a' }, deps)
    const eventsBefore = (await db.select().from(events).where(eq(events.runId, runId))).length
    const again = await askPerson(runId, nodeRunId, ask({ findingId: 'f9' }))
    expect(again).toMatchObject({ id: first.id, state: 'answered', answerOption: 'a' })
    expect(await db.select().from(questions).where(eq(questions.runId, runId))).toHaveLength(1)
    expect(await status(runId)).toBe('running')
    expect((await db.select().from(events).where(eq(events.runId, runId))).length).toBe(eventsBefore)
  })
  test('the same holds for a question about no finding', async () => {
    const { runId, nodeRunId } = await runningRun()
    const first = await askPerson(runId, nodeRunId, ask())
    await answerQuestion(first.id, { option: 'a' }, deps)
    expect((await askPerson(runId, nodeRunId, ask())).id).toBe(first.id)
    expect(await db.select().from(questions).where(eq(questions.runId, runId))).toHaveLength(1)
  })
  test('a caller\'s own leave option keeps its words but goes last', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask({ options: [{ id: LEAVE, label: 'Skip it', means: 'No change.' }, ...opts], recommended: null }))
    expect(q.options.map(o => o.id)).toEqual(['a', 'b', LEAVE])
    expect(q.options.at(-1)).toEqual({ id: LEAVE, label: 'Skip it', means: 'No change.' })
  })
  test('nobody waits on a cancelled run\'s question', async () => {
    const { runId, nodeRunId } = await runningRun()
    await askPerson(runId, nodeRunId, ask())
    expect(await openQuestion(runId)).not.toBeNull()
    await cancelRun(runId)
    expect(await openQuestion(runId)).toBeNull()
  })
})

describe('answering', () => {
  test('a listed option is recorded with who and when, the run resumes, and the decision is registered once', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    const done = await answerQuestion(q.id, { option: 'b' }, deps)
    expect(done).toMatchObject({ state: 'answered', answerOption: 'b', actor: 'tester, at this computer' })
    expect(done.answeredAt).toBeTruthy()
    expect(await status(runId)).toBe('running')
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!.state).toBe('running')
    const all = (await db.select().from(events).where(eq(events.runId, runId))).map(e => e.type)
    expect(all).toContain('node.question_answered')
    // A choice with no words of the person's own is kept with the problem only, not as a decision for later tasks.
    expect(await entries(projectId)).toHaveLength(0)
    expect(await openQuestion(runId)).toBeNull()
    expect((await takeAnswer(q.id))!.answerOption).toBe('b')
    expect(sent.at(-1)).toEqual({ name: 'factory/question.answered', data: { runId, questionId: q.id } })
  })

  test('other needs words; an unknown option is refused', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await failsWith(answerQuestion(q.id, { option: OTHER }, deps), 409, strings.question.needWords)
    await failsWith(answerQuestion(q.id, { option: OTHER, text: '   ' }, deps), 409, strings.question.needWords)
    await failsWith(answerQuestion(q.id, { option: 'nope' }, deps), 409, strings.question.unknownOption)
    expect(await status(runId)).toBe('waiting_approval')
    expect(await entries(projectId)).toHaveLength(0)
    const done = await answerQuestion(q.id, { option: OTHER, text: 'do it my way' }, deps)
    expect(done).toMatchObject({ answerOption: OTHER, answerText: 'do it my way' })
    const [decision] = await entries(projectId)
    expect(decision!.text).toContain('do it my way')
    expect(decision!.text).not.toContain('Which way?')
  })

  test('the second answer is refused and adds nothing', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await answerQuestion(q.id, { option: 'a', text: 'the old way is tested' }, deps)
    await failsWith(answerQuestion(q.id, { option: 'b' }, deps), 409, strings.question.alreadyAnswered)
    expect(await entries(projectId)).toHaveLength(1)
    expect((await takeAnswer(q.id))!.answerOption).toBe('a')
  })

  test('two answers at once leave exactly one answer and one decision', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    const results = await Promise.allSettled([answerQuestion(q.id, { option: 'a', text: 'one' }, deps), answerQuestion(q.id, { option: 'b', text: 'two' }, deps)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(await entries(projectId)).toHaveLength(1)
    expect((await db.select().from(events).where(eq(events.runId, runId))).filter(e => e.type === 'node.question_answered')).toHaveLength(1)
  })

  test('a cancelled run no longer waits, and the open question did not block the cancel', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await cancelRun(runId)
    expect(await status(runId)).toBe('cancelled')
    await failsWith(answerQuestion(q.id, { option: 'a' }, deps), 409, strings.question.notWaiting)
    expect(await entries(projectId)).toHaveLength(0)
  })

  test('a question that does not exist is 404', async () => {
    await failsWith(answerQuestion('nope', { option: 'a' }, deps), 404, strings.question.notFound)
  })

  test('the answer is capped', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    const done = await answerQuestion(q.id, { option: OTHER, text: `  ${'w'.repeat(5000)} ` }, deps)
    expect(done.answerText!.length).toBeLessThanOrEqual(1000)
  })
})

describe('what the person decided, in words', () => {
  const base: Question = { id: 'q', runId: 'r', nodeRunId: 'n', findingId: null, kind: 'finding', text: 'The change may not do what you asked. The app ran a check and saw the problem happen.', why: '', detail: null, options: [{ id: 'fix', label: 'Fix it', means: '' }, { id: LEAVE, label: 'Leave it as it is', means: '' }], recommended: null, touches: [], state: 'answered', answerOption: LEAVE, answerText: null, actor: 'x', answeredAt: now() }
  const pay = { type: 'logic' as const, file: 'src/pay.ts' }

  test('a choice without the person\'s own words is no decision', () => {
    for (const answerOption of ['fix', LEAVE]) expect(decisionText({ ...base, answerOption }, pay)).toBeNull()
    expect(decisionText({ ...base, kind: 'fix_held', answerOption: 'keep' }, pay)).toBeNull()
    expect(decisionText({ ...base, answerText: '   ' }, pay)).toBeNull()
  })

  test('with their words it says what it was about, what they chose and their words, never the generic question', () => {
    const left = decisionText({ ...base, answerText: 'the price is rounded down on purpose' }, pay)!
    expect(left).toBe(strings.question.decision({ about: strings.question.about('finding', pay), choice: strings.question.chose('finding', LEAVE), words: 'the price is rounded down on purpose' }))
    expect(left).toContain('src/pay.ts')
    expect(left).toContain('leave it as it is')
    expect(left).toContain('the price is rounded down on purpose')
    expect(left).not.toContain(base.text)
    const own = decisionText({ ...base, answerOption: OTHER, answerText: 'my own plan' }, pay)!
    expect(own).toContain('my own plan')
    expect(own).toContain('src/pay.ts')
    const kept = decisionText({ ...base, kind: 'fix_held', answerOption: 'keep', answerText: 'that file is fine to touch' }, pay)!
    expect(kept).toContain('keep the fix')
    expect(kept).toContain('that file is fine to touch')
    expect(decisionText({ ...base, answerText: 'later' })).toContain('later')
  })
})

describe('delivery', () => {
  test('an answer for a run of another computer is recorded, not sent, and the relay delivers it once', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await db.update(runs).set({ machineId: 'elsewhere' }).where(eq(runs.id, runId))
    const before = sent.length
    await answerQuestion(q.id, { option: 'a', text: 'keep it simple' }, deps)
    expect(sent.length).toBe(before)
    expect(await entries(projectId)).toHaveLength(1)
    await db.update(runs).set({ machineId: (await import('@/engine/machine')).thisMachine().id }).where(eq(runs.id, runId))
    const relayed: { name: string; data: Record<string, unknown> }[] = []
    const send = async (e: { name: string; data: Record<string, unknown> }) => void relayed.push(e)
    expect(await deliverPending(send, 'approval', 'plan', 'question')).toBeGreaterThanOrEqual(1)
    expect(relayed.filter(e => e.name === 'question' && e.data.questionId === q.id)).toHaveLength(1)
    await deliverPending(send, 'approval', 'plan', 'question')
    expect(relayed.filter(e => e.name === 'question' && e.data.questionId === q.id)).toHaveLength(1)
  })

  test('two passes at once send one answer once', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await db.update(runs).set({ machineId: 'elsewhere' }).where(eq(runs.id, runId))
    await answerQuestion(q.id, { option: 'a' }, deps)
    await db.update(runs).set({ machineId: (await import('@/engine/machine')).thisMachine().id }).where(eq(runs.id, runId))
    const relayed: { name: string; data: Record<string, unknown> }[] = []
    const send = async (e: { name: string; data: Record<string, unknown> }) => void relayed.push(e)
    await Promise.all([deliverPending(send, 'approval', 'plan', 'question'), deliverPending(send, 'approval', 'plan', 'question')])
    expect(relayed.filter(e => e.name === 'question' && e.data.questionId === q.id)).toHaveLength(1)
  })

  test('when telling the run fails the answer stays recorded and the relay tells it later', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    const done = await answerQuestion(q.id, { option: 'a', text: 'keep it simple' }, { ...deps, send: async () => { throw new Error('inngest is down') } })
    expect(done.state).toBe('answered')
    expect(await entries(projectId)).toHaveLength(1)
    const relayed: unknown[] = []
    markWaiting(runId)
    await relayTick(async e => void relayed.push(e), 'approval', 'plan', 'question')
    expect(relayed).toContainEqual({ name: 'question', data: { runId, questionId: q.id } })
  })
})

describe('an answer the run has not taken yet', () => {
  const g = globalThis as { __factoryWaiting?: Set<string>; __factoryWaitingSeeded?: boolean }
  /** As when the app starts again: nothing in memory, the database read once. */
  const restart = async () => {
    // Runs left waiting by earlier tests belong to no one here: only the run under test can make the relay look.
    await db.update(runs).set({ machineId: 'gone' }).where(eq(runs.status, 'waiting_approval'))
    g.__factoryWaiting?.clear()
    g.__factoryWaitingSeeded = false
    await seedWaiting()
  }
  const told = (relayed: { name: string; data: Record<string, unknown> }[], id: string) => relayed.filter(e => e.name === 'question' && e.data.questionId === id).length

  test('an answer given while the run\'s own app was closed is told to the run when the app starts again', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await db.update(runs).set({ machineId: 'elsewhere' }).where(eq(runs.id, runId))
    await answerQuestion(q.id, { option: 'a' }, deps) // recorded on another computer: not told
    await db.update(runs).set({ machineId: (await import('@/engine/machine')).thisMachine().id }).where(eq(runs.id, runId))
    await restart()
    const relayed: { name: string; data: Record<string, unknown> }[] = []
    await relayTick(async e => void relayed.push(e), 'approval', 'plan', 'question')
    expect(told(relayed, q.id)).toBe(1)
  })

  test('an answer told before the run was listening is told again, until the run has taken it', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await answerQuestion(q.id, { option: 'a' }, deps) // told at once, as on this computer
    expect((await db.select().from(questions).where(eq(questions.id, q.id)))[0]!.deliveredAt).not.toBeNull()
    await restart()
    const relayed: { name: string; data: Record<string, unknown> }[] = []
    const tick = () => relayTick(async e => void relayed.push(e), 'approval', 'plan', 'question')
    await tick()
    expect(told(relayed, q.id)).toBe(0) // just told: not again yet
    await db.update(questions).set({ deliveredAt: new Date(Date.now() - RESEND_AFTER_MS - 1000).toISOString() }).where(eq(questions.id, q.id))
    await tick()
    expect(told(relayed, q.id)).toBe(1)
    expect((await consumeAnswer(q.id))!.answerOption).toBe('a')
    expect((await db.select().from(questions).where(eq(questions.id, q.id)))[0]!.consumedAt).not.toBeNull()
    await db.update(questions).set({ deliveredAt: new Date(Date.now() - RESEND_AFTER_MS - 1000).toISOString() }).where(eq(questions.id, q.id))
    await restart()
    await tick()
    expect(told(relayed, q.id)).toBe(1) // taken: never again
  })

  test('the app\'s own telling keeps watching until the run has taken the answer', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    g.__factoryWaiting?.clear()
    await answerQuestion(q.id, { option: 'a' }, deps)
    expect(g.__factoryWaiting?.has(runId)).toBe(true)
    await relayTick(async () => undefined, 'approval', 'plan', 'question')
    expect(g.__factoryWaiting?.has(runId)).toBe(true)
    await consumeAnswer(q.id)
    await relayTick(async () => undefined, 'approval', 'plan', 'question')
    expect(g.__factoryWaiting?.has(runId)).toBe(false)
  })

  test('a run that was cancelled is not told', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await db.update(runs).set({ machineId: 'elsewhere' }).where(eq(runs.id, runId))
    await answerQuestion(q.id, { option: 'a' }, deps)
    await db.update(runs).set({ machineId: (await import('@/engine/machine')).thisMachine().id, status: 'cancelled' }).where(eq(runs.id, runId))
    const relayed: { name: string; data: Record<string, unknown> }[] = []
    await deliverPending(async e => void relayed.push(e), 'approval', 'plan', 'question')
    expect(told(relayed, q.id)).toBe(0)
  })
})

describe('the route', () => {
  const HOST = 'localhost:3000'
  const post = (runId: string, questionId: string, body: unknown, headers: Record<string, string> = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }) =>
    POST(new Request(`http://${HOST}/x`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ runId, questionId }) })

  test('refuses a request that does not come from the app\'s own page', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    expect((await post(runId, q.id, { option: 'a' }, { host: HOST })).status).toBe(403)
    expect((await post(runId, q.id, { option: 'a' }, { host: HOST, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await openQuestion(runId))!.id).toBe(q.id)
  })

  test('checks the body, and the question must belong to the run in the address', async () => {
    const { runId, nodeRunId } = await runningRun()
    const other = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    expect((await post(runId, q.id, { option: '' })).status).toBe(400)
    expect((await post(runId, q.id, { text: 'x' })).status).toBe(400)
    expect((await post(runId, q.id, { option: 'a', text: 5 })).status).toBe(400)
    expect((await post(other.runId, q.id, { option: 'a' })).status).toBe(404)
    expect((await post(runId, 'nope', { option: 'a' })).status).toBe(404)
    expect((await openQuestion(runId))!.id).toBe(q.id)
  })

  test('answers, and maps a refusal to its status', async () => {
    const { runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    expect((await post(runId, q.id, { option: OTHER })).status).toBe(409)
    const ok = await post(runId, q.id, { option: 'a' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ state: 'answered', answerOption: 'a' })
    const again = await post(runId, q.id, { option: 'a' })
    expect(again.status).toBe(409)
    expect((await again.json()).error).toBe(strings.question.alreadyAnswered)
  })
})

describe('an answer about a file', () => {
  /** A real finding, recorded the way the review records it, about `file` (or about no file). */
  async function aboutFile(file: string | null) {
    const { projectId, runId, nodeRunId } = await runningRun()
    const dir = mkdtempSync(join(tmpdir(), 'factory-q-'))
    mkdirSync(join(dir, 'src/rounding'), { recursive: true })
    writeFileSync(join(dir, 'src/rounding/round.ts'), 'a\nb\n')
    const [row] = await recordFindings(runId, nodeRunId, 1, [{ finding: { type: 'logic', ...(file ? { file, line: 1 } : {}), problem: 'It rounds down.', severity: 'medium', affects: [], decisions: [] }, reporters: ['logic'], count: 1 }], dir)
    const q = await askPerson(runId, nodeRunId, ask({ findingId: row!.id }))
    return { projectId, q }
  }

  test('the decision keeps the file it was about', async () => {
    const { projectId, q } = await aboutFile('src/rounding/round.ts')
    await answerQuestion(q.id, { option: LEAVE, text: 'on purpose' }, deps)
    const [decision] = await entries(projectId)
    expect(JSON.parse(decision!.paths!)).toEqual(['src/rounding/round.ts'])
  })

  test('a problem with no file gives a decision with no paths', async () => {
    const { projectId, q } = await aboutFile(null)
    await answerQuestion(q.id, { option: LEAVE, text: 'on purpose' }, deps)
    const [decision] = await entries(projectId)
    expect(decision!.paths).toBeNull()
  })

  test('without the person\'s own words there is no decision, so no paths either', async () => {
    const { projectId, q } = await aboutFile('src/rounding/round.ts')
    await answerQuestion(q.id, { option: LEAVE }, deps)
    expect(await entries(projectId)).toHaveLength(0)
  })
})

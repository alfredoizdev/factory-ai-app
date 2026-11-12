import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { events, nodeRuns, projectNotes, projects, questions, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { askPerson, answerQuestion, decisionText, LEAVE, openQuestion, OTHER, QuestionError, takeAnswer, type Question } from '@/engine/questions'
import { deliverPending, relayTick, markWaiting } from '@/engine/relay'
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
    const found = await entries(projectId)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('Which way?')
    expect(found[0]!.text).toContain('Use the new way')
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
    expect((await entries(projectId))[0]!.text).toBe('Which way? — do it my way')
  })

  test('the second answer is refused and adds nothing', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await answerQuestion(q.id, { option: 'a' }, deps)
    await failsWith(answerQuestion(q.id, { option: 'b' }, deps), 409, strings.question.alreadyAnswered)
    expect(await entries(projectId)).toHaveLength(1)
    expect((await takeAnswer(q.id))!.answerOption).toBe('a')
  })

  test('two answers at once leave exactly one answer and one decision', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    const results = await Promise.allSettled([answerQuestion(q.id, { option: 'a' }, deps), answerQuestion(q.id, { option: 'b' }, deps)])
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
  const base: Question = { id: 'q', runId: 'r', nodeRunId: 'n', findingId: null, kind: 'finding', text: 'Which way?', why: '', options: [...opts, { id: LEAVE, label: 'Leave it', means: '' }], recommended: null, touches: [], state: 'answered', answerOption: 'b', answerText: null, actor: 'x', answeredAt: now() }
  test('the question and the choice; the person\'s own words after', () => {
    expect(decisionText(base)).toBe('Which way? — Use the new way')
    expect(decisionText({ ...base, answerText: 'but carefully' })).toBe('Which way? — Use the new way — but carefully')
    expect(decisionText({ ...base, answerOption: OTHER, answerText: 'my own plan' })).toBe('Which way? — my own plan')
  })
})

describe('delivery', () => {
  test('an answer for a run of another computer is recorded, not sent, and the relay delivers it once', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    await db.update(runs).set({ machineId: 'elsewhere' }).where(eq(runs.id, runId))
    const before = sent.length
    await answerQuestion(q.id, { option: 'a' }, deps)
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

  test('when telling the run fails the answer stays recorded and the relay tells it later', async () => {
    const { projectId, runId, nodeRunId } = await runningRun()
    const q = await askPerson(runId, nodeRunId, ask())
    const done = await answerQuestion(q.id, { option: 'a' }, { ...deps, send: async () => { throw new Error('inngest is down') } })
    expect(done.state).toBe('answered')
    expect(await entries(projectId)).toHaveLength(1)
    const relayed: unknown[] = []
    markWaiting(runId)
    await relayTick(async e => void relayed.push(e), 'approval', 'plan', 'question')
    expect(relayed).toContainEqual({ name: 'question', data: { runId, questionId: q.id } })
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

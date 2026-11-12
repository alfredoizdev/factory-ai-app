import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { nodeRuns, projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { mergeDuplicates, recordFindings, setFinding } from '@/engine/findings'
import { askPerson } from '@/engine/questions'
import { appendEventSync } from '@/engine/events'
import { addEntry, label } from '@/engine/register'
import { updateNote } from '@/engine/memory'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import type { Finding } from '@/engine/review'
import { GET } from '@/app/api/runs/[runId]/findings/route'
import { strings } from '@/ui/strings'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()
const f = (over: Partial<Finding> = {}): Finding => ({ type: 'logic', problem: 'p', severity: 'medium', affects: [], decisions: [], ...over })

async function run() {
  const projectId = ulid()
  const workflowId = ulid()
  await db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now() })
  await db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() })
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'x' })
  await db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId))
  const node = (await db.select().from(nodeRuns).where(eq(nodeRuns.runId, runId))).find(n => n.blockId === 'human')!
  await db.update(nodeRuns).set({ state: 'running' }).where(eq(nodeRuns.id, node.id))
  return { projectId, runId, nodeRunId: node.id }
}
const get = (runId: string) => GET(new Request('http://localhost:3000/x'), { params: Promise.resolve({ runId }) })
type Body = { findings: { id: string; title: string; how: string; ending: string; detail: Record<string, string> }[]; question: { id: string } | null; touched: { number: number; label: string; text: string }[] }

test('one entry per problem, in the order they first appeared, with the question the run waits on', async () => {
  const { projectId, runId, nodeRunId } = await run()
  const dir = process.cwd()
  const rows = await recordFindings(runId, nodeRunId, 1, mergeDuplicates([
    { focus: 'logic', finding: f({ file: 'package.json', line: 1, problem: 'first' }) },
    { focus: 'logic', finding: f({ type: 'security', file: 'package.json', line: 1, problem: 'second' }) },
  ]), dir)
  await setFinding(rows[0]!.id, { state: 'corrected', reason: strings.findings.fixedChecked, evidence: { exitCode: 0, markerSeen: false, outputTail: 'ok', at: now() } })
  await setFinding(rows[1]!.id, { state: 'open', reason: 'needs a look' })
  const decision = (await addEntry(projectId, { kind: 'decision', text: 'We use Stripe', source: 'question' }))!
  const q = await askPerson(runId, nodeRunId, { findingId: rows[1]!.id, kind: 'finding', text: 'Fix it?', why: `It touches a decision you made (${label(decision.number)}).`, options: [{ id: 'fix', label: 'Fix', means: 'm' }], recommended: 'fix', touches: [decision.number], detail: 'The reviewer said so' })
  const res = await get(runId)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Body
  expect(body.findings.map(x => [x.ending, x.how])).toEqual([['fixed', 'checked'], ['needs_you', 'not_checked']])
  expect(body.findings[0]!.title).toBe(strings.findings.title.logic)
  expect(body.question!.id).toBe(q.id)
  expect(body.touched).toEqual([{ number: decision.number, label: label(decision.number), kind: 'decision', text: 'We use Stripe', paths: [] }])
})

test('nothing is shown for a run with no findings and no question', async () => {
  const { runId } = await run()
  expect(await (await get(runId)).json()).toEqual({ findings: [], question: null, touched: [] })
})

test('what leaves the server is redacted: the question\'s detail too', async () => {
  const { runId, nodeRunId } = await run()
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123'
  await askPerson(runId, nodeRunId, { findingId: null, kind: 'finding', text: 'Fix it?', why: 'w', options: [{ id: 'fix', label: 'Fix', means: 'm' }], recommended: null, touches: [], detail: `it leaks ${secret}` })
  expect(JSON.stringify(await (await get(runId)).json())).not.toContain(secret)
})

test('a run that does not exist is a plain 404', async () => {
  const res = await get('nope')
  expect(res.status).toBe(404)
  expect(((await res.json()) as { error: string }).error).toBe(strings.errors.runNotFound)
})

test('a decision named in the reasons measured for the human check is explained too', async () => {
  const { projectId, runId, nodeRunId } = await run()
  const decision = (await addEntry(projectId, { kind: 'decision', text: 'We use Stripe', source: 'question' }))!
  await appendEventSync({ runId, nodeRunId, type: 'node.assessed', payload: { blockId: 'human', level: 'high', reasons: [`It touches a decision you made (${label(decision.number)}).`] } }, db)
  const body = (await (await get(runId)).json()) as Body
  expect(body.touched.map(t => t.text)).toEqual(['We use Stripe'])
})

test('a number in what a reviewer or the checker wrote is explained from every entry of the project, a switched-off one too', async () => {
  const { projectId, runId, nodeRunId } = await run()
  const core = (await addEntry(projectId, { kind: 'core', text: 'Ask me before changing src/app/', paths: ['src/app/'], source: 'person' }))!
  const rule = (await addEntry(projectId, { kind: 'rule', text: 'Buttons are blue', source: 'person' }))!
  await updateNote(projectId, rule.id, { enabled: false })
  const rows = await recordFindings(runId, nodeRunId, 1, mergeDuplicates([
    { focus: 'logic', finding: f({ problem: `agreed decision ${label(core.number)} says to ask; rule ${label(rule.number)} too` }) },
  ]), process.cwd())
  await setFinding(rows[0]!.id, { state: 'refuted', reason: `Decision ${label(core.number)} appears nowhere in the repo` })
  const body = (await (await get(runId)).json()) as Body
  expect(body.touched).toEqual([
    { number: core.number, label: label(core.number), kind: 'core', text: 'Ask me before changing src/app/', paths: ['src/app/'] },
    { number: rule.number, label: label(rule.number), kind: 'rule', text: 'Buttons are blue', paths: [] },
  ])
})

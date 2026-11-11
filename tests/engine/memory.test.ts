import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, migrateDb } from '@/db/client'
import { projects, runs, workflows } from '@/db/schema'
import { defaultGraph } from '@/domain/graph'
import { eventsSince } from '@/engine/events'
import { orchestrateRun, type StepApi } from '@/engine/inngest/execute-run'
import { addNote, deleteNote, distill, giveRules, learnFrom, listNotes, updateNote } from '@/engine/memory'
import { promptsOf } from '@/engine/prompts'
import { createRun, publishVersion, saveDraft } from '@/engine/run'
import type { AgentExecutionInput, AgentProvider } from '@/providers/types'

beforeAll(() => migrateDb())
const now = () => new Date().toISOString()

async function project(): Promise<{ projectId: string; runId: string }> {
  const projectId = ulid()
  const workflowId = ulid()
  db.insert(projects).values({ id: projectId, projectId, name: 'p', createdAt: now(), repoPath: '/repo' }).run()
  db.insert(workflows).values({ id: workflowId, projectId, name: 'w', draftJson: JSON.stringify(defaultGraph()), createdAt: now(), updatedAt: now() }).run()
  await saveDraft(workflowId, defaultGraph())
  await publishVersion(workflowId)
  const { runId } = await createRun({ workflowId, request: 'add a ring around the crest' })
  return { projectId, runId }
}

test('rules are added once, reworded, switched off and deleted', async () => {
  const { projectId } = await project()
  const a = addNote(projectId, '  Buttons keep a 3px border  ')!
  expect(a.text).toBe('Buttons keep a 3px border')
  expect(addNote(projectId, 'buttons keep a 3px border')).toBeNull() // the same rule twice is noise
  expect(addNote(projectId, '   ')).toBeNull()
  expect(updateNote(projectId, a.id, { text: 'Buttons keep a 4px border' })!.text).toBe('Buttons keep a 4px border')
  expect(updateNote(projectId, a.id, { enabled: false })!.enabled).toBe(false)
  expect(updateNote('another-project', a.id, { enabled: true })).toBeNull()
  expect(deleteNote(projectId, a.id)).toBe(true)
  expect(listNotes(projectId)).toEqual([])
})

test('only a lasting rule is learned from what the person said; a one-off is not', async () => {
  expect(await distill('r', 'make it 5px', async () => 'NONE')).toBeNull()
  expect(await distill('r', 'never touch the header', async () => 'No tocar nunca el header.')).toBe('No tocar nunca el header.')
  expect(await distill('r', 'x', async () => { throw new Error('no claude') })).toBeNull()
  const { projectId, runId } = await project()
  await learnFrom(runId, 'always keep the team pink', 'approved', async () => 'Keep the team pink')
  expect(listNotes(projectId).map(n => [n.text, n.source, n.runId])).toEqual([['Keep the team pink', 'approved', runId]])
})

test('a task is given the rules switched on when it starts, once, and the Input card can show them', async () => {
  const { projectId, runId } = await project()
  addNote(projectId, 'Keep the team pink')
  const off = addNote(projectId, 'Use serif fonts')!
  updateNote(projectId, off.id, { enabled: false })
  expect(giveRules(runId)).toEqual(['Keep the team pink'])
  addNote(projectId, 'Added later')
  expect(giveRules(runId)).toEqual(['Keep the team pink']) // fixed for this task
  expect((await eventsSince(runId, 0)).filter(e => e.type === 'run.memory')).toHaveLength(1)
  expect(promptsOf(runId).find(p => p.kind === 'memory')!.text).toBe('• Keep the team pink')
})

test('the planner and the builder are handed the rules', async () => {
  const { projectId, runId } = await project()
  addNote(projectId, 'Keep the team pink')
  db.update(runs).set({ providerId: 'files' }).where(eq(runs.id, runId)).run()
  const calls: AgentExecutionInput[] = []
  const provider: AgentProvider = {
    id: 'files',
    isDemo: false,
    needsWorkspace: true,
    async *execute(input) {
      calls.push(input)
      yield { type: 'done', summary: 'ok', source: 'system' }
    },
  }
  const step: StepApi = {
    run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
    waitForEvent: async () => {
      throw new Error('parked')
    },
  }
  await orchestrateRun(runId, step, { resolveProvider: () => provider, createWorktree: (_r, id) => ({ path: `/wt/${id}`, branch: `b-${id}`, baseCommit: 'abc' }) }).catch(() => undefined)
  expect(calls.find(c => c.blockKind === 'plan')!.notes).toEqual(['Keep the team pink'])
  expect(calls.find(c => c.blockKind === 'build')!.notes).toEqual(['Keep the team pink'])
  expect(calls.find(c => c.blockKind === 'tests')?.notes).toBeUndefined()
})

import { and, asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import type { AskMode } from '@/domain/ask-mode'
import { projectMachines, projects, workflows } from '@/db/schema'
import { defaultGraph, LANE_SPACING, STAGE_ORDER, type Block } from '@/domain/graph'
import { ProjectSettingsError, validRepoRoot } from '@/engine/project-settings'
import { publishVersion, saveDraft } from '@/engine/run'
import { projectHere, setLocal, thisMachine } from '@/engine/machine'
import { strings } from '@/ui/strings'

// Projects: one repository each, with its own flow and its own tasks.

export type ProjectSummary = {
  projectId: string
  name: string
  repoPath: string | null
  workflowId: string
  baseStatus: string
  baseMessage: string | null
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = (await db.select().from(projects).orderBy(asc(projects.createdAt)))
  const out: ProjectSummary[] = []
  for (const shared of rows) {
    const p = (await projectHere(shared.id)) ?? shared
    const wf = (await db.select().from(workflows).where(eq(workflows.projectId, p.id)).orderBy(asc(workflows.createdAt)))[0]
    if (wf) out.push({ projectId: p.id, name: p.name, repoPath: p.repoPath, workflowId: wf.id, baseStatus: p.baseStatus, baseMessage: p.baseMessage })
  }
  return out
}

/** An extra check chosen at setup: a Tests block of its own, running this command. */
export type ExtraCheck = { label: string; command: string }

const NAME = /^[^\n\r\0]{1,80}$/
const COMMAND = /^[^\n\r\0]{1,500}$/

/**
 * Makes a repository a project: its settings, its flow (the default one, plus a Tests block per extra check chosen),
 * published so a task can run at once. Refused when the folder is not a repository's top folder or is a project already.
 */
export async function createProject(input: {
  path: string
  name: string
  testCommand: string | null
  checks: readonly ExtraCheck[]
  /** When the app stops for the person. Absent: only about what matters. */
  askMode?: AskMode
}): Promise<{ projectId: string; workflowId: string }> {
  const repoPath = validRepoRoot(input.path.trim())
  const name = input.name.trim()
  if (!NAME.test(name)) throw new ProjectSettingsError(strings.projects.badName)
  // A folder is one project on this computer: its path, this computer's or from before machines existed.
  const mine = await db.select({ id: projectMachines.projectId }).from(projectMachines).where(and(eq(projectMachines.machineId, thisMachine().id), eq(projectMachines.repoPath, repoPath)))
  const legacy = await db.select({ id: projects.id }).from(projects).where(eq(projects.repoPath, repoPath))
  if (mine.length > 0 || legacy.length > 0) throw new ProjectSettingsError(strings.projects.alreadyProject)
  const testCommand = input.testCommand?.trim() || null
  if (testCommand && !COMMAND.test(testCommand)) throw new ProjectSettingsError(strings.projects.badCommand)
  for (const c of input.checks) if (!COMMAND.test(c.command.trim()) || !NAME.test(c.label.trim())) throw new ProjectSettingsError(strings.projects.badCommand)

  const askMode = input.askMode ?? 'what_matters'
  const projectId = ulid()
  const workflowId = ulid()
  const now = new Date().toISOString()
  const graph = defaultGraph()
  const testsColumn = STAGE_ORDER.indexOf('tests') * LANE_SPACING
  const extra: Block[] = input.checks.map((c, i) => ({
    id: `tests-${i + 1}`,
    kind: 'tests',
    label: c.label.trim(),
    enabled: true,
    config: { testCommand: c.command.trim() },
    position: { x: testsColumn, y: (i + 1) * 340 },
  }))
  await db.transaction(async tx => {
    await tx.insert(projects).values({ id: projectId, projectId, name, testCommand, askMode, autoApproveLowRisk: askMode !== 'everything', createdAt: now })
    await setLocal(projectId, { repoPath }, tx)
    await tx.insert(workflows).values({ id: workflowId, projectId, name, draftJson: JSON.stringify(graph), createdAt: now, updatedAt: now })
  })
  await saveDraft(workflowId, { blocks: [...graph.blocks, ...extra] })
  await publishVersion(workflowId)
  return { projectId, workflowId }
}

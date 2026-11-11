import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '@/db/client'
import { projects, workflows } from '@/db/schema'
import { defaultGraph, LANE_SPACING, STAGE_ORDER, type Block } from '@/domain/graph'
import { ProjectSettingsError, validRepoRoot } from '@/engine/project-settings'
import { publishVersion, saveDraft } from '@/engine/run'
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

export function listProjects(): ProjectSummary[] {
  const rows = db.select().from(projects).orderBy(asc(projects.createdAt)).all()
  const out: ProjectSummary[] = []
  for (const p of rows) {
    const wf = db.select().from(workflows).where(eq(workflows.projectId, p.id)).orderBy(asc(workflows.createdAt)).get()
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
  /** The person's own choice at setup; off unless they turn it on. */
  autoApproveLowRisk?: boolean
}): Promise<{ projectId: string; workflowId: string }> {
  const repoPath = validRepoRoot(input.path.trim())
  const name = input.name.trim()
  if (!NAME.test(name)) throw new ProjectSettingsError(strings.projects.badName)
  if (db.select().from(projects).where(eq(projects.repoPath, repoPath)).get()) throw new ProjectSettingsError(strings.projects.alreadyProject)
  const testCommand = input.testCommand?.trim() || null
  if (testCommand && !COMMAND.test(testCommand)) throw new ProjectSettingsError(strings.projects.badCommand)
  for (const c of input.checks) if (!COMMAND.test(c.command.trim()) || !NAME.test(c.label.trim())) throw new ProjectSettingsError(strings.projects.badCommand)

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
  db.transaction(tx => {
    tx.insert(projects).values({ id: projectId, projectId, name, repoPath, testCommand, autoApproveLowRisk: input.autoApproveLowRisk === true, createdAt: now }).run()
    tx.insert(workflows).values({ id: workflowId, projectId, name, draftJson: JSON.stringify(graph), createdAt: now, updatedAt: now }).run()
  })
  await saveDraft(workflowId, { blocks: [...graph.blocks, ...extra] })
  await publishVersion(workflowId)
  return { projectId, workflowId }
}

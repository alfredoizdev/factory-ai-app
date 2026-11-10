import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// IDs are ULIDs (the demo workflow is the literal 'demo'); timestamps are ISO UTC strings.
// Every row carries projectId so a future multi-user version is not a rewrite.
// All foreign keys cascade on delete: removing a project, workflow or run removes everything beneath it.

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
})

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  draftJson: text('draft_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const workflowVersions = sqliteTable(
  'workflow_versions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
    graphJson: text('graph_json').notNull(),
    hash: text('hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  t => [index('workflow_versions_workflow_idx').on(t.workflowId)],
)

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    // restrict, not cascade: deleting a workflow or version must never erase run history (the audit trail).
    // Deleting the project itself still cascades through projectId and removes everything beneath it, deliberately
    // (an explicit "remove the whole thing" action); restrict only guards against pruning a workflow or version.
    workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'restrict' }),
    versionId: text('version_id').notNull().references(() => workflowVersions.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    request: text('request').notNull(),
    providerId: text('provider_id').notNull(),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  t => [index('runs_workflow_idx').on(t.workflowId)],
)

export const nodeRuns = sqliteTable(
  'node_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    state: text('state').notNull(),
    attempt: integer('attempt').notNull().default(1),
    summary: text('summary'),
    failureCause: text('failure_cause'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  t => [index('node_runs_run_idx').on(t.runId)],
)

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id').references(() => nodeRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  t => [index('jobs_run_idx').on(t.runId)],
)

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id').references(() => nodeRuns.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  t => [uniqueIndex('events_run_sequence_uq').on(t.runId, t.sequence)],
)

// Claims: anything a language model says. Never merged with evidence.
export const claims = sqliteTable(
  'claims',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id').notNull().references(() => nodeRuns.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    createdAt: text('created_at').notNull(),
  },
  t => [index('claims_node_run_idx').on(t.nodeRunId)],
)

// Evidence: only what a non-model process produced (test runs, exit codes, git diffs, CI checks).
export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id').notNull().references(() => nodeRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    dataJson: text('data_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  t => [index('evidence_node_run_idx').on(t.nodeRunId)],
)

// tokens and costCents are nullable on purpose: null means "not reported", never 0.
export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id').notNull().references(() => nodeRuns.id, { onDelete: 'cascade' }),
    tokens: integer('tokens'),
    costCents: integer('cost_cents'),
    createdAt: text('created_at').notNull(),
  },
  t => [index('usage_records_node_run_idx').on(t.nodeRunId)],
)

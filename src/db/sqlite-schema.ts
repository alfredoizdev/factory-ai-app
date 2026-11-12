import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// The schema as it was in SQLite, kept only so the one-off copy (scripts/copy-from-sqlite.ts) can read the old
// file. The app itself uses ./schema (Postgres).
// IDs are ULIDs (the demo workflow is the literal 'demo'); timestamps are ISO UTC strings.
// Every row carries projectId so a future multi-user version is not a rewrite.
// Deletes cascade downward: a project removes everything beneath it; a run removes its node runs, events,
// claims, evidence and usage records. The exceptions are runs.workflowId and runs.versionId (restrict), so
// deleting or pruning a workflow or version can never erase run history. See those columns.

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  // One project = one local repository (design §7). Null until set; a real agent cannot run without it.
  repoPath: text('repo_path'),
  // The project's configured test command. It is the allow-list: nothing else runs as an evidence step.
  testCommand: text('test_command'),
  // The person's choice: a run whose change is measured as low risk does not stop at the human check. Off unless
  // they turn it on; never a default.
  autoApproveLowRisk: integer('auto_approve_low_risk', { mode: 'boolean' }).notNull().default(false),
  // The prepared base: a copy of the main branch with its dependencies installed once, which every task's working
  // copy starts from instead of installing again. 'none' until prepared; 'installing', 'ready' or 'failed' after.
  baseStatus: text('base_status').notNull().default('none'),
  baseCommit: text('base_commit'),
  // A fingerprint of the lockfile the base was installed from: a task whose lockfile differs installs for itself.
  baseLockHash: text('base_lock_hash'),
  baseMessage: text('base_message'),
  baseUpdatedAt: text('base_updated_at'),
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
    /** A short name for the task, the person's or suggested from the request: how it is told apart on screen. */
    title: text('title'),
    /** True once the person named the task: a later suggestion never replaces their words. */
    titleByPerson: integer('title_by_person', { mode: 'boolean' }).notNull().default(false),
    /** The project rules this task was given when it started (JSON list of texts); null before it started. */
    memoryJson: text('memory_json'),
    providerId: text('provider_id').notNull(),
    // The run's own working copy (one per run, never per job). Null for demo runs, which touch no repository.
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    baseCommit: text('base_commit'),
    /** Set on a follow-up: the run whose approved change this one continues from. */
    parentRunId: text('parent_run_id'),
    /**
     * Where bringing this run into the project starts from. For a follow-up whose parent was never brought over, the
     * parent's own starting point, so both changes travel together; otherwise null and baseCommit is used.
     */
    deliveryBase: text('delivery_base'),
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
  // One node run per block per run: openNodeIn, decideHumanNode and the cancel sweep all resolve a block to its row.
  t => [index('node_runs_run_idx').on(t.runId), uniqueIndex('node_runs_run_block_uq').on(t.runId, t.blockId)],
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

// Every decision a person makes at a human check: who, when, which way, why, and on which exact change. The gate
// acts only on a row here — an approval event with no row behind it opens nothing.
export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id').notNull().references(() => nodeRuns.id, { onDelete: 'cascade' }),
    decision: text('decision').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    /** The hash of the change the person was shown. Null for a run that changed no files (the demo). */
    diffHash: text('diff_hash'),
    createdAt: text('created_at').notNull(),
    /** When the run acted on this decision. A decision is acted on once; the next round needs a new one. */
    consumedAt: text('consumed_at'),
  },
  t => [index('approvals_run_idx').on(t.runId)],
)

// Images a person attached to a request, a request for changes, or a follow-up. The file lives under the app's own
// data folder; the agent is given read access to it and told where it is.
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    /** Null until the request it was attached to is sent. */
    runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    /** Set when it came with a request for changes, so it reaches that round and no other. */
    approvalId: text('approval_id').references(() => approvals.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
  },
  t => [index('attachments_run_idx').on(t.runId)],
)

/**
 * The project's memory: lessons that hold beyond one task ("buttons use a 3px border", "never touch the header").
 * Learned from what the person said on a task (a fast model keeps only what is general), or written by them. Each says
 * where it came from; the person can edit, switch off or delete any of them.
 */
export const projectNotes = sqliteTable(
  'project_notes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** 'person' when written by hand; otherwise the kind of message it was learned from. */
    source: text('source').notNull(),
    /** The task it was learned on; null when written by hand. Not a foreign key: deleting the task keeps the lesson. */
    runId: text('run_id'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  t => [index('project_notes_project_idx').on(t.projectId)],
)

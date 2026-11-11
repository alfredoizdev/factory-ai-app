// The id of the demo provider. The UI's Demo badge matches runs.providerId against this exact value.
// Deliberately dependency-free: importing it must not pull in the engine or the database.
export const DEMO_PROVIDER_ID = 'demo'

// The real builder: the `claude` CLI, run headless inside the run's worktree.
export const CLAUDE_PROVIDER_ID = 'claude'

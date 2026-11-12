// The environment given to anything run for a project: its checks, its install, the agent working in its copy.
// This app's own settings must not travel with it. NODE_ENV=development (set by `next dev`) makes another project's
// `next build` fail; the framework and Inngest variables would point another app at this one; and the database and
// storage keys are this app's secrets, which an unattended agent and its commands have no business holding.

const OWN = /^(__NEXT|NEXT_|INNGEST|TURBOPACK|NODE_ENV$|PORT$|HOSTNAME$|FACTORY_|DATABASE_URL|LOCAL_DATABASE_URL$|NEON_|R2_)/

/** The person's environment without this app's own variables, plus `extra`. */
export function projectEnv(extra: Record<string, string> = {}, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(from)) {
    if (!OWN.test(k)) env[k] = v
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv
}

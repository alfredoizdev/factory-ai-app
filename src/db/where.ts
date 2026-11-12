// Which database the app talks to. `npm run dev` sets FACTORY_DB=local: the test Postgres on this computer
// (docker-compose.yml), with pictures kept as local files only. Without it (`npm run dev:neon`) the app uses Neon
// and R2, where the real tasks live.

/** The local test database's address. Not a secret: it only listens on this computer. */
const LOCAL_URL = 'postgres://factory:factory@127.0.0.1:54410/ai_factory'

/** True when the app runs on the local test database. */
export function localDb(): boolean {
  return process.env.FACTORY_DB === 'local'
}

/** The connection string in use, or undefined when Neon's is not set. */
export function databaseUrl(): string | undefined {
  if (localDb()) return process.env.LOCAL_DATABASE_URL ?? LOCAL_URL
  return process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
}

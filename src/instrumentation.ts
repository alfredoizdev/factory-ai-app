// Runs once when the app's server starts. On the server only: records this computer's name for the others, and
// starts the relay that tells this computer's Inngest about decisions made on other computers.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const g = globalThis as { __factoryRelay?: ReturnType<typeof setInterval> }
  if (g.__factoryRelay) return
  const { registerMachine } = await import('@/engine/machine')
  const { deliverPending, RELAY_EVERY_MS } = await import('@/engine/relay')
  const { inngest, APPROVAL_DECIDED, PLAN_DECIDED } = await import('@/engine/inngest/client')
  await registerMachine().catch(() => undefined)
  g.__factoryRelay = setInterval(() => {
    void deliverPending(e => inngest.send(e), APPROVAL_DECIDED, PLAN_DECIDED).catch(() => undefined)
  }, RELAY_EVERY_MS)
}

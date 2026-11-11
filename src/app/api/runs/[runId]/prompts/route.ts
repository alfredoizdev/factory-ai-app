import { promptsOf } from '@/engine/prompts'

// What was asked on this task, in order. Reading only.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  return Response.json({ prompts: promptsOf(runId) })
}

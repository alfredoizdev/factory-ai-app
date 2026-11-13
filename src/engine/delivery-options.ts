import { askClaude, branchFromWords, suggestBranchWords, suggestCommitMessage, type AskModel } from '@/engine/branch-name'
import { changedFiles, deliveryState, pendingDiff, requestOf, type KeepOptions } from '@/engine/delivery'

/**
 * How a change is kept: the name the person typed, or — before the first keep — a branch name and a commit message a
 * short model writes from what changed, at once. Used by the Save button and by keeping a change on its own.
 */
export async function keepOptionsFor(runId: string, name: string, ask: AskModel = askClaude): Promise<KeepOptions> {
  const first = !(await deliveryState(runId)).kept
  const request = (await requestOf(runId)) ?? ''
  const [fallbackName, message] = first
    ? await Promise.all([name === '' ? suggestedName(runId, ask) : null, suggestCommitMessage(request, (await pendingDiff(runId)), ask)])
    : [null, null]
  return { name: name || null, fallbackName, message }
}

async function suggestedName(runId: string, ask: AskModel): Promise<string | null> {
  const request = (await requestOf(runId))
  return request === null ? null : branchFromWords(runId, await suggestBranchWords(request, (await changedFiles(runId)), ask))
}

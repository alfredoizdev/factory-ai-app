import { QUESTION_ANSWERED } from '@/engine/inngest/client'
import { APPROVAL_WAIT, MAX_IGNORED_DECISIONS, isCancelled, type StepApi } from '@/engine/inngest/execute-run'
import { consumeAnswer, type Question } from '@/engine/questions'

/**
 * Waits for the person's answer to a question already asked, and takes it. The event only says "look": the answer is
 * read from its row, and reading it marks it taken (the relay tells the run again until then). An event with no answer
 * behind it is ignored and the wait goes on. `parked`: no answer came (the wait expired), and the run stays waiting on
 * the person; nothing is decided for them.
 *
 * Step ids are `id(...)` of `read-answer-${tag}${qid}-first`, `question-${tag}${qid}-${attempt}` and
 * `read-answer-${tag}${qid}-${attempt}`. `qid` names what was asked about: the question's own id unless the caller
 * has a name of its own (the review passes the finding's id, the ids its runs already parked on).
 */
export async function waitForAnswer(
  step: StepApi,
  id: (n: string) => string,
  runId: string,
  asked: Question,
  tag: string,
  qid: string = asked.id,
): Promise<Question | 'parked' | 'cancelled'> {
  let answer: Question | null = asked.state === 'answered' ? await step.run(id(`read-answer-${tag}${qid}-first`), () => consumeAnswer(asked.id)) : null
  for (let attempt = 0; attempt < MAX_IGNORED_DECISIONS && answer === null; attempt++) {
    const arrived = await step.waitForEvent(id(`question-${tag}${qid}-${attempt}`), { event: QUESTION_ANSWERED, timeout: APPROVAL_WAIT, match: 'data.runId' })
    if (!arrived) return 'parked'
    const read = await step.run(id(`read-answer-${tag}${qid}-${attempt}`), async () => ((await isCancelled(runId)) ? ('cancelled' as const) : consumeAnswer(asked.id)))
    if (read === 'cancelled') return 'cancelled'
    answer = read
  }
  return answer ?? 'parked'
}

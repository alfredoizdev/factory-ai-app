import { Inngest } from 'inngest'

export const inngest = new Inngest({ id: 'ai-factory' })

export const RUN_REQUESTED = 'factory/run.requested'
export const APPROVAL_DECIDED = 'factory/approval.decided'
/** The person said build the plan, or plan again. The word itself is read from the run's events, not from this. */
export const PLAN_DECIDED = 'factory/plan.decided'
/** The person answered a question. Which answer is read from the question's row, not from this. */
export const QUESTION_ANSWERED = 'factory/question.answered'

// All user-facing copy lives here so another language can be added later.
export const strings = {
  app: {
    name: 'AI Factory',
    tagline: 'Design a flow of blocks and watch AI agents run it.',
  },
  blocks: {
    input: 'Input',
    plan: 'Plan',
    build: 'Build',
    tests: 'Tests',
    review: 'Review',
    approve: 'Approve',
    human: 'Human check',
    ship: 'Ship',
  },
  validation: {
    missingRequired: (label: string) => `The ${label} block is required.`,
    duplicateSingleton: (label: string) => `Only one ${label} block is allowed.`,
    disabledRequired: (label: string) => `The ${label} block is required and cannot be disabled.`,
  },
  summary: {
    generic: {
      queued: 'Waiting to start.',
      running: 'Working on it.',
      waiting_approval: 'Waiting for your decision.',
      passed: 'Done.',
      failed: 'Failed.',
      cancelled: 'Cancelled. Nothing after this ran.',
      skipped: 'Skipped for this change.',
      blocked: 'Blocked. Needs a decision or a fix before it can run.',
    },
    input: {
      passed: 'Input received.',
    },
    plan: {
      running: 'Drafting the plan.',
      passed: 'Plan is ready.',
      failed: 'No usable plan was produced.',
    },
    build: {
      queued: 'Waits for the plan.',
      running: 'Agents are writing the code.',
      passed: 'Code is written.',
      failed: 'The build failed.',
    },
    tests: {
      queued: 'Waits for the build.',
      running: 'Running the tests.',
    },
    review: {
      queued: 'Waits for the tests.',
      running: 'A reviewer is reading the change.',
      passed: 'Review passed.',
      failed: 'Review found problems.',
    },
    approve: {
      queued: 'Waits for the review.',
      waiting_approval: 'Waiting for your yes.',
      passed: 'Approved.',
      failed: 'Not approved. Nothing ships.',
    },
    human: {
      queued: 'Waits for the earlier steps.',
      waiting_approval: 'Stopped. Nothing ships without your yes.',
      passed: 'You approved it.',
      failed: 'You turned it down. Nothing ships.',
    },
    ship: {
      queued: 'Ships after your yes.',
      running: 'Shipping now.',
      passed: 'Shipped.',
      failed: 'Did not ship.',
      cancelled: 'Not shipped.',
      blocked: 'Held back until a decision is made.',
    },
    testsPassed: (passed: number, total: number) => `${passed} of ${total} passed.`,
    testsFailed: (passed: number, failed: number, total: number) =>
      `${passed} of ${total} passed. ${failed} failed.`,
    testsRunning: (total: number) => `Running ${total} ${total === 1 ? 'test' : 'tests'}.`,
    jobsFinished: (count: number) => `${count} agent ${count === 1 ? 'job' : 'jobs'} finished.`,
    passedWithoutCounts: 'Passed, but no test counts were recorded.',
    failedWithoutCounts: 'Failed. No test counts were recorded.',
  },
  demo: {
    projectName: 'Demo project',
    workflowName: 'Demo workflow',
  },
}

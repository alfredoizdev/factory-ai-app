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
}

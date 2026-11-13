// Which model each step of a task uses, as chosen in the wizard. A step's model is stored on its block
// (config.model); "default" stores nothing and leaves the agent's own default.

export const MODEL_STEPS = ['plan', 'build', 'review'] as const
export type ModelStep = (typeof MODEL_STEPS)[number]

export const MODEL_CHOICES = ['default', 'haiku', 'sonnet', 'opus'] as const
export type ModelChoice = (typeof MODEL_CHOICES)[number]

export type StepModels = Record<ModelStep, ModelChoice>

export const PRESETS = {
  fast: { plan: 'haiku', build: 'sonnet', review: 'sonnet' },
  balanced: { plan: 'default', build: 'default', review: 'default' },
  best: { plan: 'opus', build: 'opus', review: 'opus' },
} as const satisfies Record<string, StepModels>

export type PresetName = keyof typeof PRESETS

export const DEFAULT_MODELS: StepModels = PRESETS.balanced

/** The preset these choices are exactly, or null when the person changed a step by hand. */
export function presetOf(models: StepModels): PresetName | null {
  const names = Object.keys(PRESETS) as PresetName[]
  return names.find(n => MODEL_STEPS.every(s => PRESETS[n][s] === models[s])) ?? null
}

/** The model name to store on a step's block, or null for the default. */
export function modelName(choice: ModelChoice | undefined): string | null {
  return choice === undefined || choice === 'default' ? null : choice
}

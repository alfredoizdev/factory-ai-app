import { cleanExplanation, explainPrompt } from '@/engine/failure-explain'

const block = { blockId: 'b', label: 'Build', kind: 'tests', cause: null, message: 'Failed.', command: 'npm run build', exitCode: 1, signal: null, output: 'Type error: missing prop' }

test('an explanation is kept only when it is a few lines of plain prose', () => {
  expect(cleanExplanation('  "The page could not be built.\nA piece is missing its **title**."  ')).toBe('The page could not be built. A piece is missing its title.')
  expect(cleanExplanation('ok')).toBeNull()
  expect(cleanExplanation('Here is the fix:\n```ts\nconst a = 1\n```\nThat should do it.')).toBeNull()
  expect(cleanExplanation('What happened:\n- the build failed\n- a title is missing')).toBeNull()
  expect(cleanExplanation('x'.repeat(900))).toBeNull()
})

test('the model is given the request, the check and the end of what it printed', () => {
  const prompt = explainPrompt('Landing page', block)
  expect(prompt).toContain('Landing page')
  expect(prompt).toContain('npm run build')
  expect(prompt).toContain('Type error: missing prop')
  expect(prompt).toContain('NOT a programmer')
})

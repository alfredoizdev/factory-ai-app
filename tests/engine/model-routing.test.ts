import { classifyArea, routeModel, wantsRouting } from '@/engine/model-routing'
import { strings } from '@/ui/strings'

const build = { kind: 'build', model: 'opus', modelFrontend: 'sonnet', modelBackend: 'opus' }

test('only a build block with a per-area model asks for routing', () => {
  expect(wantsRouting(build)).toBe(true)
  expect(wantsRouting({ kind: 'build', model: 'opus' })).toBe(false)
  expect(wantsRouting({ kind: 'tests', modelFrontend: 'x' })).toBe(false)
})

test('the area picks its model, and the note says what was chosen', () => {
  expect(routeModel(build, 'frontend')).toEqual({ model: 'sonnet', note: strings.routing.note('front end', 'sonnet') })
  expect(routeModel(build, 'backend').model).toBe('opus')
})

test('both, unknown, or an unset side fall back to the block model, then the default', () => {
  expect(routeModel(build, 'both').model).toBe('opus')
  expect(routeModel(build, null)).toEqual({ model: 'opus', note: strings.routing.note(strings.routing.unknown, 'opus') })
  expect(routeModel({ kind: 'build', modelBackend: 'opus' }, 'frontend')).toEqual({
    note: strings.routing.note('front end', strings.routing.defaultModel),
  })
})

test('the classifier accepts one of three words and nothing else', async () => {
  expect(await classifyArea('r', async () => 'Frontend.\n')).toBe('frontend')
  expect(await classifyArea('r', async () => 'backend')).toBe('backend')
  expect(await classifyArea('r', async () => 'It is mostly frontend work')).toBeNull()
  expect(
    await classifyArea('r', async () => {
      throw new Error('no claude')
    }),
  ).toBeNull()
})

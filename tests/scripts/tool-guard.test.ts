import { execFile, execFileSync, execSync, spawn } from 'node:child_process'
import { askClaude } from '@/engine/branch-name'
import { refusal, refusedRealTools } from '../tool-guard'

// The guard in setup.ts is what keeps every other test off GitHub and the model. Each check here clears what it
// reached, or this test itself would be failed by the guard afterwards, as any other would.
const reached = () => refusedRealTools.splice(0)

test('starting the real gh or claude throws with a clear sentence, by any starter and any spelling', () => {
  expect(() => execFile('gh', ['pr', 'create'], () => undefined)).toThrow(refusal('gh'))
  expect(() => execFileSync('/usr/local/bin/gh', ['auth', 'status'])).toThrow(refusal('gh'))
  expect(() => spawn('claude', ['-p', 'x'])).toThrow(refusal('claude'))
  expect(() => execSync('gh pr view')).toThrow(refusal('gh'))
  expect(reached()).toHaveLength(4)
})

test('app code that falls back quietly is still caught: the reach is kept for the test to be failed', async () => {
  // askClaude is what the app uses by default to name a branch; its caller falls back when it fails.
  await expect(askClaude('name this')).rejects.toThrow(refusal('claude'))
  expect(reached()).toEqual([refusal('claude')])
})

test('every other program runs as usual', () => {
  expect(execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/^git version/)
  expect(reached()).toEqual([])
})

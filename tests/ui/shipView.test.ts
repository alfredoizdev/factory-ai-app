import { shipView } from '@/ui/canvas/shipView'
import { strings } from '@/ui/strings'
import type { ShipState } from '@/engine/ship'

const base: ShipState = { pr: { number: 4, url: 'u', state: 'open', conflicts: false }, checks: [], checksDone: true, checksFailed: false, deploy: [], mergedAt: null, onHold: false }

test('nothing to show before a pull request exists', () => {
  expect(shipView('ship', { ...base, pr: null })).toBeNull()
})

test('checks on their way: running, with each check as a step', () => {
  const v = shipView('ship', { ...base, checksDone: false, checks: [{ name: 'Vercel', state: 'pending', url: null }, { name: 'Lint', state: 'passed', url: null }] })!
  expect(v).toMatchObject({ state: 'running', summary: strings.ship.cardChecking(1, 2), summaryIsClaim: false })
  expect(v.steps).toEqual([strings.ship.stepPushed, strings.ship.stepPr(4), 'Vercel: running', 'Lint: passed'])
})

test('ready to merge waits on the person; a failure or a conflict fails', () => {
  expect(shipView('ship', base)!.state).toBe('waiting_approval')
  expect(shipView('ship', { ...base, checksFailed: true })!.state).toBe('failed')
  expect(shipView('ship', { ...base, pr: { ...base.pr!, conflicts: true } })!.summary).toBe(strings.ship.conflicts)
})

test('merged: deploying, then live; with nothing reporting, just merged', () => {
  const merged = { ...base, pr: { ...base.pr!, state: 'merged' as const } }
  expect(shipView('ship', { ...merged, deploy: [{ name: 'Vercel', state: 'pending', url: null }] })).toMatchObject({ state: 'running', summary: strings.ship.cardDeploying })
  const live = shipView('ship', { ...merged, deploy: [{ name: 'Vercel', state: 'passed', url: null }] })!
  expect(live).toMatchObject({ state: 'passed', summary: strings.ship.cardLive })
  expect(live.steps).toContain('Vercel: passed')
  expect(shipView('ship', merged)).toMatchObject({ state: 'passed', summary: strings.ship.merged })
})

test('a ready pull request on hold still waits on the person, and says it is on hold', () => {
  const view = shipView('ship', { ...base, onHold: true })!
  expect(view.state).toBe('waiting_approval')
  expect(view.summary).toBe(strings.ship.cardOnHold)
})

test('just sent, no check reported yet: it says it is looking, not "0 of 0"', () => {
  expect(shipView('ship', { ...base, checksDone: false })).toMatchObject({ state: 'running', summary: strings.ship.cardLooking })
})

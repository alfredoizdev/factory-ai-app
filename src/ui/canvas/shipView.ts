import type { ShipState } from '@/engine/ship'
import { strings } from '@/ui/strings'
import type { NodeRunView } from './BlockCard'

/**
 * The Ship card, drawn from what GitHub reports: every step so far as a line, running while checks or a deploy are
 * on their way, waiting on the person once it can be merged, passed once merged (and live, when something said so).
 * Facts read from GitHub, never a model's claim.
 */
export function shipView(blockId: string, ship: ShipState): NodeRunView | null {
  if (!ship.pr) return null
  const s = strings.ship
  const steps = [s.stepPushed, s.stepPr(ship.pr.number), ...ship.checks.map(c => `${c.name}: ${s.checkState[c.state]}`)]
  const base = { blockId, summaryIsClaim: false, steps }
  if (ship.pr.state === 'closed') return { ...base, state: 'cancelled', summary: s.closed }
  if (ship.pr.state === 'open') {
    if (ship.pr.conflicts) return { ...base, state: 'failed', summary: s.conflicts }
    if (ship.checksFailed) return { ...base, state: 'failed', summary: s.someFailed }
    if (!ship.checksDone) {
      const done = ship.checks.filter(c => c.state !== 'pending').length
      return { ...base, state: 'running', summary: ship.checks.length === 0 ? s.cardLooking : s.cardChecking(done, ship.checks.length) }
    }
    return { ...base, state: 'waiting_approval', summary: ship.onHold ? s.cardOnHold : s.cardReady }
  }
  const after = [...steps, s.merged, ...ship.deploy.map(d => `${d.name}: ${s.checkState[d.state]}`)]
  if (ship.deploy.some(d => d.state === 'failed')) return { ...base, steps: after, state: 'failed', summary: s.deployFailed }
  if (ship.deploy.some(d => d.state === 'pending')) return { ...base, steps: after, state: 'running', summary: s.cardDeploying }
  return { ...base, steps: after, state: 'passed', summary: ship.deploy.length > 0 ? s.cardLive : s.merged }
}

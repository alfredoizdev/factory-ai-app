import type { ShipState } from '@/engine/ship'

/** The pull request is open, its checks all finished and fine, and it has no conflicts: the next step is to publish. */
export function checksPassed(ship: ShipState | null | undefined): boolean {
  return ship?.pr?.state === 'open' && ship.checksDone && !ship.checksFailed && !ship.pr.conflicts
}

/**
 * The change is ready to publish now: the checks passed and the person did not put it on hold. The result card, the
 * tab title and the browser notice all read this one answer, so they cannot disagree.
 */
export function readyToPublish(ship: ShipState | null | undefined): boolean {
  return checksPassed(ship) && !ship?.onHold
}

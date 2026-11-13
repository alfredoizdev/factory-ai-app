// When the app stops for the person. The three values are stored on a project and compared by code: never reword them.

export type AskMode = 'what_matters' | 'everything' | 'small_changes'
export const ASK_MODES: readonly AskMode[] = ['what_matters', 'everything', 'small_changes']

/**
 * A project's mode. NULL (made before the mode existed, or copied from the backup) comes from the old switch:
 * on is "small changes skip my final check", off is "everything". A stored value nobody knows reads as the safest.
 */
export function askModeOf(row: { askMode: string | null; autoApproveLowRisk: boolean }): AskMode {
  if (row.askMode === null) return row.autoApproveLowRisk ? 'small_changes' : 'everything'
  return (ASK_MODES as readonly string[]).includes(row.askMode) ? (row.askMode as AskMode) : 'everything'
}

/** The final check opens on its own for a low-risk change. */
export function passesLowRisk(mode: AskMode, stopForMe: boolean): boolean {
  return (mode === 'what_matters' || mode === 'small_changes') && !stopForMe
}

/** Simple plans start on their own, and a passed change is sent and opened as a pull request. */
export function shipsOnItsOwn(mode: AskMode, stopForMe: boolean): boolean {
  return mode === 'what_matters' && !stopForMe
}

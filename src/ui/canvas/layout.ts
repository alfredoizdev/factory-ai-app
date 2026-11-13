/** The command card's width; the canvas keeps this much room on its right so no block sits under it. */
export const COMMAND_CARD_WIDTH = 460

/** Fixed to the right edge (the steps layout) the card is drawn this much larger, so its text is read comfortably at full height. */
export const DOCKED_ZOOM = 1.08
/** The room the docked card takes on the right, for whatever is drawn beside it. */
export const DOCKED_WIDTH = Math.ceil(COMMAND_CARD_WIDTH * DOCKED_ZOOM)

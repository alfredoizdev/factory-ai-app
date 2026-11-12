// Client-safe: how a register entry is named. Imports nothing, so the screen can use it without the server's modules.

/** 7 -> "D-07": how an entry is named wherever a person or a reviewer refers to it. */
export const label = (n: number): string => `D-${String(n).padStart(2, '0')}`

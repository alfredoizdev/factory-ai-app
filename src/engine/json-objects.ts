// The JSON objects inside an agent's answer, wherever they sit in its prose. An answer often quotes code before its
// object ("renders {sum(2, 2)}"), so no brace is taken to be the start: every one is tried, and an object is kept only
// when the text from that brace to its matching brace parses as JSON.

/** Where the object that opens at `start` closes, counting braces outside strings; -1 when it never closes. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** Every JSON object in the text, the one that starts last first (an object inside another comes before it). */
export function jsonObjectsFromEnd(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  for (let start = text.lastIndexOf('{'); start >= 0; start = start > 0 ? text.lastIndexOf('{', start - 1) : -1) {
    const end = closingBrace(text, start)
    if (end < 0) continue
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) found.push(value as Record<string, unknown>)
    } catch {
      // braces in prose or code, not an object
    }
  }
  return found
}

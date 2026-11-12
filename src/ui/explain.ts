import { strings } from '@/ui/strings'

/** What an earlier decision or core area a sentence mentions says, in its own words. */
export type Touched = { number: number; label: string; kind: string; text: string }

/** Puts the entry's own words next to its label; a number with nothing behind it is not shown at all. */
export function explained(sentence: string, touched: readonly Touched[] = []): string {
  return sentence.replace(/\bD-(\d+)\b/g, (_m, n: string) => {
    const entry = touched.find(t => t.number === Number(n))
    return entry ? `${entry.label}: \u201c${entry.text}\u201d` : strings.question.earlierDecision
  })
}

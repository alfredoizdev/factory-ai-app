import { strings } from '@/ui/strings'

/** What an earlier decision, rule or core area a sentence mentions says, in its own words. */
export type Touched = { number: number; label: string; kind: string; text: string; paths?: readonly string[] }

/** How much of an entry's own words stands in for its number in a sentence. */
const MAX_QUOTED = 80

const clipped = (text: string) => (text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED - 1).trimEnd()}…` : text)

/** The entry as a short phrase the person recognises; a number with no entry behind it is an earlier decision of theirs. */
function phraseOf(entry: Touched | undefined): string {
  if (!entry) return strings.question.earlierDecision
  if (entry.kind === 'core') return strings.question.entryAs.core(entry.paths && entry.paths.length > 0 ? entry.paths.join(', ') : `“${clipped(entry.text)}”`)
  return entry.kind === 'rule' ? strings.question.entryAs.rule(clipped(entry.text)) : strings.question.entryAs.decision(clipped(entry.text))
}

// A number with the word a model put before it ("agreed decision D-03", "Rule D-02"): the word goes with the number, so
// the phrase that replaces both does not say it twice.
const NUMBER = /(\b(?:[Tt]he\s+)?(?:[Aa]greed\s+|[Ee]arlier\s+)?(?:[Dd]ecision|[Rr]ule|[Cc]ore area|[Ee]ntry)\s+)?\bD-(\d+)\b/g

/** Puts the entry's own words where its number was; a number with nothing behind it is never shown bare. */
export function explained(sentence: string, touched: readonly Touched[] = []): string {
  return sentence.replace(NUMBER, (_m, lead: string | undefined, n: string, at: number) => {
    const phrase = phraseOf(touched.find(t => t.number === Number(n)))
    const startsSentence = /[A-Z]/.test(lead?.[0] ?? '') || (!lead && /(^|[.!?]\s+)$/.test(sentence.slice(0, at)))
    return startsSentence ? `${phrase[0]!.toUpperCase()}${phrase.slice(1)}` : phrase
  })
}

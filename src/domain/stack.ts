// What a project started from scratch can be built with, as the person picks it in the wizard, and the words the
// app writes from that choice: a standing rule for later tasks and the text of the first task.

export type StackOption = { id: string; label: string; /** How it is named in a sentence, when that differs from the tile. */ name?: string }

export const FRONT_ENDS: readonly StackOption[] = [
  { id: 'nextjs', label: 'Next.js' },
  { id: 'react', label: 'React' },
  { id: 'angular', label: 'Angular' },
  { id: 'vue', label: 'Vue' },
  { id: 'svelte', label: 'Svelte' },
  { id: 'astro', label: 'Astro' },
  { id: 'html', label: 'Plain HTML', name: 'plain HTML and CSS' },
]

export const BACK_ENDS: readonly StackOption[] = [
  { id: 'node', label: 'Node server', name: 'a Node server (Express)' },
  { id: 'prisma', label: 'Prisma' },
  { id: 'postgres', label: 'Postgres', name: 'PostgreSQL' },
  { id: 'python', label: 'Python API', name: 'a Python API (FastAPI)' },
]

/** The person's choice. No front end and no back end means "let the agents choose". */
export type Stack = { frontEnd: string | null; backEnds: readonly string[] }

export const NO_STACK: Stack = { frontEnd: null, backEnds: [] }

const nameOf = (o: StackOption) => o.name ?? o.label

/** The chosen technologies by name, front end first, in the order the wizard shows them. Unknown ids are dropped. */
export function stackNames(stack: Stack): string[] {
  const front = FRONT_ENDS.filter(o => o.id === stack.frontEnd).map(nameOf)
  const back = BACK_ENDS.filter(o => stack.backEnds.includes(o.id)).map(nameOf)
  return [...front, ...back]
}

/** "a, b and c". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A stack as it arrives from a request body: only ids the wizard offers survive. */
export function cleanStack(raw: { frontEnd?: string | null; backEnds?: readonly string[] } | null | undefined): Stack {
  const frontEnd = FRONT_ENDS.some(o => o.id === raw?.frontEnd) ? (raw!.frontEnd as string) : null
  const backEnds = BACK_ENDS.filter(o => raw?.backEnds?.includes(o.id)).map(o => o.id)
  return { frontEnd, backEnds }
}

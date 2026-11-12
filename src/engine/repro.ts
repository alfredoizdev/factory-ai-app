export type Repro = { command: string; marker: string; files: { path: string; content: string }[] }
export type ReproRun = { exitCode: number | null; markerSeen: boolean; outputTail: string; at: string }

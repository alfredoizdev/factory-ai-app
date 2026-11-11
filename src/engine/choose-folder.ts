import { execFile } from 'node:child_process'

// The app runs on the person's own Mac, so picking a project can use the system's folder window instead of making
// them type a path. Only the path comes back; nothing is read from the folder here.

export type FolderChoice = { path: string } | { cancelled: true }
export type RunScript = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

const SCRIPT = [
  // `activate` brings osascript's own dialog to the front; it controls no other app, so no permission is asked for.
  'activate',
  'POSIX path of (choose folder with prompt "Choose the project folder" default location (path to desktop folder))',
]
/** The person may take a while to choose; after this the dialog is abandoned. */
const PICK_TIMEOUT_MS = 10 * 60_000
/** AppleScript's "user cancelled" error number. */
const USER_CANCELLED = '-128'

const osascript: RunScript = args =>
  new Promise(resolve => {
    execFile('osascript', args, { timeout: PICK_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

export class FolderPickerError extends Error {}

// One window at a time: a second click while it is open joins the first instead of stacking dialogs.
let open: Promise<FolderChoice> | null = null

export function chooseFolder(run: RunScript = osascript): Promise<FolderChoice> {
  open ??= (async () => {
    try {
      const { code, stdout, stderr } = await run(SCRIPT.flatMap(line => ['-e', line]))
      if (code === 0) {
        const path = stdout.trim().replace(/\/+$/, '')
        if (path) return { path }
      }
      if (stderr.includes(USER_CANCELLED)) return { cancelled: true }
      throw new FolderPickerError(stderr.trim() || `osascript exited with code ${code}`)
    } finally {
      open = null
    }
  })()
  return open
}

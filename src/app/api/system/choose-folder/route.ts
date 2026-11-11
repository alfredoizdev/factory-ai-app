import { chooseFolder, FolderPickerError } from '@/engine/choose-folder'
import { rejectCrossSite } from '@/engine/same-origin'
import { detectTestCommand } from '@/engine/test-runner'
import { strings } from '@/ui/strings'

// Opens the Mac's own folder window. POST and guarded: a page elsewhere must not be able to pop dialogs on screen.
export async function POST(req: Request) {
  const refused = rejectCrossSite(req)
  if (refused) return refused
  if (process.platform !== 'darwin') return Response.json({ error: strings.settings.pickerMacOnly }, { status: 501 })
  try {
    const choice = await chooseFolder()
    if ('cancelled' in choice) return Response.json({ cancelled: true })
    return Response.json({ path: choice.path, testCommand: detectTestCommand(choice.path) })
  } catch (e) {
    if (e instanceof FolderPickerError) return Response.json({ error: strings.settings.pickerFailed }, { status: 500 })
    throw e
  }
}

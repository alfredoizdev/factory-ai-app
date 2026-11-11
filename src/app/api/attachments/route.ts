import { AttachmentError, MAX_IMAGE_BYTES, saveAttachment } from '@/engine/attachments'
import { requireOwnPage } from '@/engine/same-origin'
import { strings } from '@/ui/strings'

// One image per request, from the app's own page. Its bytes decide whether it is an image, not its name.
export async function POST(req: Request) {
  const refused = requireOwnPage(req)
  if (refused) return refused
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return Response.json({ error: strings.attachments.notImage }, { status: 400 })
  if (file.size > MAX_IMAGE_BYTES) return Response.json({ error: strings.attachments.tooBig(MAX_IMAGE_BYTES / 1024 / 1024) }, { status: 413 })
  try {
    return Response.json(saveAttachment(file.name, Buffer.from(await file.arrayBuffer())), { status: 201 })
  } catch (e) {
    if (e instanceof AttachmentError) return Response.json({ error: e.message }, { status: 400 })
    throw e
  }
}

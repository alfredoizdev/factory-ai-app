// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { Composer, readyImageIds, type ComposerImage } from '@/ui/canvas/Composer'
import { strings } from '@/ui/strings'

beforeAll(() => {
  URL.createObjectURL ??= () => 'blob:preview'
  URL.revokeObjectURL ??= () => undefined
})
afterEach(() => vi.unstubAllGlobals())

let latest: ComposerImage[] = []
const report = (images: ComposerImage[]) => {
  latest = images
}
function Box() {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  useEffect(() => report(images), [images])
  return <Composer inputId="c" label="Ask" placeholder="p" text={text} onText={setText} images={images} onImages={setImages} />
}

const png = (name = 'shot.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })

test('a dropped image shows as a thumbnail while it attaches, then is ready to send', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'att1' }), { status: 201 })))
  render(<Box />)
  fireEvent.drop(screen.getByTestId('composer'), { dataTransfer: { files: [png()], types: ['Files'] } })
  const thumb = await screen.findByTestId('composer-thumb')
  await vi.waitFor(() => expect(thumb).toHaveAttribute('data-status', 'ready'))
  await vi.waitFor(() => expect(readyImageIds(latest)).toEqual(['att1'])) // reported after the render that drew it
})

test('a pasted image is attached; pasted text is left to the box', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'att2' }), { status: 201 })))
  render(<Box />)
  fireEvent.paste(screen.getByLabelText('Ask'), { clipboardData: { files: [png('clip.png')] } })
  await vi.waitFor(() => expect(readyImageIds(latest)).toEqual(['att2']))
})

test('the cross takes an image off, and it is not sent', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'att3' }), { status: 201 })))
  render(<Box />)
  fireEvent.drop(screen.getByTestId('composer'), { dataTransfer: { files: [png('a.png')], types: ['Files'] } })
  await vi.waitFor(() => expect(readyImageIds(latest)).toEqual(['att3']))
  fireEvent.click(screen.getByRole('button', { name: strings.attachments.remove('a.png') }))
  expect(screen.queryByTestId('composer-thumb')).toBeNull()
  expect(readyImageIds(latest)).toEqual([])
})

test('a file that is not an image is not attached, and the box says why', () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  render(<Box />)
  fireEvent.drop(screen.getByTestId('composer'), { dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })], types: ['Files'] } })
  expect(screen.getByRole('alert')).toHaveTextContent(strings.attachments.notImage)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('an image the server refuses is marked, with its reason, and never counted as ready', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: strings.attachments.notImage }), { status: 400 })))
  render(<Box />)
  fireEvent.drop(screen.getByTestId('composer'), { dataTransfer: { files: [png('fake.png')], types: ['Files'] } })
  const thumb = await screen.findByTestId('composer-thumb')
  await vi.waitFor(() => expect(thumb).toHaveAttribute('data-status', 'failed'))
  expect(thumb).toHaveAttribute('title', strings.attachments.notImage)
  expect(readyImageIds(latest)).toEqual([])
})

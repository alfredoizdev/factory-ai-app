import { chooseFolder, FolderPickerError, type RunScript } from '@/engine/choose-folder'
import { POST } from '@/app/api/system/choose-folder/route'

test('the chosen folder comes back as a path without its trailing slash', async () => {
  const run: RunScript = async () => ({ code: 0, stdout: '/Users/me/Desktop/comets-web/\n', stderr: '' })
  expect(await chooseFolder(run)).toEqual({ path: '/Users/me/Desktop/comets-web' })
})

test('closing the window is a cancellation, not an error', async () => {
  const run: RunScript = async () => ({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' })
  expect(await chooseFolder(run)).toEqual({ cancelled: true })
})

test('anything else is reported as a failure', async () => {
  const run: RunScript = async () => ({ code: 1, stdout: '', stderr: 'boom' })
  await expect(chooseFolder(run)).rejects.toBeInstanceOf(FolderPickerError)
})

test('a second request while the window is open joins it instead of opening another', async () => {
  let release!: () => void
  const run = vi.fn<RunScript>(() => new Promise(r => (release = () => r({ code: 0, stdout: '/a/', stderr: '' }))))
  const first = chooseFolder(run)
  const second = chooseFolder(run)
  release()
  expect(await first).toEqual({ path: '/a' })
  expect(await second).toEqual({ path: '/a' })
  expect(run).toHaveBeenCalledTimes(1)
})

test('the route refuses a request from another site before any window opens', async () => {
  const res = await POST(new Request('http://localhost:3000/api/system/choose-folder', {
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }))
  expect(res.status).toBe(403)
})

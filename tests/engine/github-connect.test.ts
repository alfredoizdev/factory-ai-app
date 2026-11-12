import { githubUrl } from '@/engine/github-connect'

test('only a link to a GitHub repository is accepted as a remote', () => {
  expect(githubUrl(' https://github.com/me/my-app/ ')).toBe('https://github.com/me/my-app')
  expect(githubUrl('https://github.com/me/my-app.git')).toBe('https://github.com/me/my-app.git')
  expect(githubUrl('git@github.com:me/my-app.git')).toBe('git@github.com:me/my-app.git')
  expect(githubUrl('https://evil.example/me/my-app')).toBeNull()
  expect(githubUrl('https://github.com/me')).toBeNull()
  expect(githubUrl('--upload-pack=touch /tmp/x')).toBeNull()
  expect(githubUrl('https://github.com/me/my-app; rm -rf ~')).toBeNull()
})

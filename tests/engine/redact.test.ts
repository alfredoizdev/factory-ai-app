import { clip, redact } from '@/engine/redact'

const R = '[redacted]'

test.each([
  ['an Anthropic key', 'key is sk-ant-api03-AbCdEf1234567890_xyzXYZ ok'],
  ['an OpenAI-style key', 'use sk-proj-abcdefghijklmnopqrstuvwx now'],
  ['a GitHub classic token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['a GitHub OAuth token', 'token gho_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['a GitHub fine-grained token', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
  ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['a Slack token', 'xoxb-1234567890-abcdefghij'],
  ['a bearer header', 'curl -H "Authorization: Bearer abc.def.ghi123456"'],
])('%s is removed', (_, text) => {
  const out = redact(text)
  expect(out).toContain(R)
  expect(out).not.toMatch(/sk-ant-api03|sk-proj-abc|ghp_abc|gho_abc|github_pat_11|AKIAIOSFODNN7|xoxb-123|abc\.def\.ghi/)
})

test('a private key block is removed whole', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\nmore\n-----END OPENSSH PRIVATE KEY-----'
  expect(redact(`before ${pem} after`)).toBe(`before ${R} after`)
})

test('secret-looking assignments keep their name and lose their value', () => {
  expect(redact('API_KEY=abc123secretvalue')).toBe(`API_KEY=${R}`)
  expect(redact('export DB_PASSWORD="hunter2hunter2"')).toBe(`export DB_PASSWORD=${R}`)
  expect(redact('{"password": "correct-horse"}')).toBe(`{"password": ${R}}`)
  expect(redact('my_token: zzz999zzz')).toBe(`my_token: ${R}`)
})

test("the value of a secret env var is removed wherever it appears, but short or harmless vars are not", () => {
  const env = { MY_SERVICE_TOKEN: 'q9w8e7r6t5y4', HOME: '/Users/me', SHORT_KEY: 'abc', PATH: '/usr/bin' }
  expect(redact('cat file -> q9w8e7r6t5y4 done', env)).toBe(`cat file -> ${R} done`)
  expect(redact('cd /Users/me && ls /usr/bin', env)).toBe('cd /Users/me && ls /usr/bin')
  expect(redact('abc is fine', env)).toBe('abc is fine')
})

test('an env value with regex characters is matched literally', () => {
  expect(redact('x a.b*c+d?e y', { WEIRD_SECRET: 'a.b*c+d?e' })).toBe(`x ${R} y`)
})

test('ordinary text is left exactly as it was', () => {
  const plain = 'Editing src/ui/Button.tsx and running npm test -- --run'
  expect(redact(plain)).toBe(plain)
})

test('clip leaves short text alone and cuts long text with an ellipsis', () => {
  expect(clip('short', 10)).toBe('short')
  expect(clip('abcdefghijkl', 5)).toBe('abcd…')
  expect(clip('abcdefghijkl', 5)).toHaveLength(5)
})

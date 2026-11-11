import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'
import { isLoopbackHost } from '@/engine/same-origin'

const get = (host: string) => proxy(new NextRequest('http://localhost:3000/canvas/demo', { headers: { host } }))

test('reads addressed to a loopback name pass through', () => {
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST']) expect(get(host).status).not.toBe(403)
})

test('reads addressed to anything else are refused, so a rebound page cannot read runs or repository paths', () => {
  for (const host of ['10.0.0.118:3000', 'evil.example', 'localhost.evil.example:3000', '127.0.0.1.nip.io:3000']) expect(get(host).status).toBe(403)
})

test('the loopback test is exact, not a prefix match', () => {
  expect(isLoopbackHost('localhost')).toBe(true)
  expect(isLoopbackHost('[::1]')).toBe(true)
  expect(isLoopbackHost('localhostx:3000')).toBe(false)
  expect(isLoopbackHost('[::2]:3000')).toBe(false)
  expect(isLoopbackHost('')).toBe(false)
})

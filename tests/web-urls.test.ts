import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkUrl } from '../src/agent/browser/urls'

const ok = (input: string, allowPrivate = false) => {
  const v = checkUrl(input, { allowPrivate })
  assert.ok(v.ok, `${input}: ${!v.ok ? v.reason : ''}`)
  return v.url
}
const refused = (input: string) => {
  const v = checkUrl(input)
  assert.equal(v.ok, false, input)
  return v.ok ? '' : v.reason
}

test('web addresses are http or https; a bare host gets https', () => {
  assert.equal(ok('example.com'), 'https://example.com/')
  assert.equal(ok('  https://example.com/a?b=1  '), 'https://example.com/a?b=1')
  assert.equal(ok('http://news.example.org'), 'http://news.example.org/')
})

test('other schemes, embedded passwords and empty input are refused', () => {
  assert.match(refused('javascript:alert(1)'), /http/)
  assert.match(refused('file:///etc/passwd'), /http/)
  assert.match(refused('data:text/html,hi'), /http/)
  assert.match(refused('https://user:pw@example.com'), /password/)
  refused('')
  refused('http://')
})

test('your own network is off limits unless allowed: loopback, private ranges, link-local, .local names', () => {
  for (const url of ['http://localhost:3000', 'http://app.localhost', 'http://127.0.0.1:8080', 'http://10.0.0.5', 'http://172.20.1.1', 'http://192.168.1.1', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[fd00::1]/', 'http://0.0.0.0', 'https://printer.local'])
    assert.match(refused(url), /network/, url)
  assert.equal(ok('http://127.0.0.1:8080/page', true), 'http://127.0.0.1:8080/page')
  assert.equal(ok('http://172.32.0.1'), 'http://172.32.0.1/') // just outside 172.16.0.0/12
})

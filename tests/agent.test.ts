import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgent, type ParentPortLike } from '../src/agent/agent'
import { PROTOCOL_VERSION } from '../src/shared/protocol'

function port() {
  const out: any[] = []
  let listener: (e: { data: unknown }) => void = () => {}
  const p: ParentPortLike = { postMessage: (m) => { out.push(m) }, on: (_e, l) => { listener = l } }
  return { p, out, send: (data: unknown) => listener({ data }) }
}
const init = { type: 'init', version: PROTOCOL_VERSION, cuaSdkPath: 'a', cuaLibraryPath: 'b', nativeHelperPath: 'c', evidenceDir: 'd' }
const tick = () => new Promise((r) => setTimeout(r, 5))

test('init answers ready; requests before init fail', async () => {
  const { p, out, send } = port()
  createAgent(p, { ping: async () => 'pong' })
  send({ type: 'request', id: '1', method: 'ping', params: {} })
  await tick()
  assert.deepEqual(out.at(-1), { type: 'failure', id: '1', error: 'The agent has not been initialised.' })
  send(init)
  assert.deepEqual(out.at(-1), { type: 'ready' })
})

test('a handler result and an unknown method', async () => {
  const { p, out, send } = port()
  createAgent(p, { ping: async () => ({ pong: true }) })
  send(init)
  send({ type: 'request', id: '2', method: 'ping', params: {} })
  send({ type: 'request', id: '3', method: 'spike.a', params: {} })
  await tick()
  assert.ok(out.some((m) => m.type === 'result' && m.id === '2' && m.value.pong === true))
  assert.ok(out.some((m) => m.type === 'failure' && m.id === '3' && /No handler for spike.a/.test(m.error)))
})

test('cancel aborts the running handler signal', async () => {
  const { p, out, send } = port()
  createAgent(p, {
    ping: (_params, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  })
  send(init)
  send({ type: 'request', id: '4', method: 'ping', params: {} })
  send({ type: 'cancel', id: '4' })
  await tick()
  assert.ok(out.some((m) => m.type === 'failure' && m.id === '4' && m.error === 'aborted'))
})

test('shutdown runs the hook, then reports shutdown-complete', async () => {
  const { p, out, send } = port()
  let closed = false
  createAgent(p, {}, { onShutdown: async () => { closed = true } })
  send(init)
  send({ type: 'shutdown' })
  await tick()
  assert.equal(closed, true)
  assert.deepEqual(out.at(-1), { type: 'shutdown-complete' })
})

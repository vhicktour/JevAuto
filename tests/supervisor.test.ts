import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Supervisor, AgentExitedError, type AgentChild } from '../src/main/supervisor'
import { PROTOCOL_VERSION, type AgentInit } from '../src/shared/protocol'

class FakeChild implements AgentChild {
  sent: any[] = []
  private messageListeners: ((m: unknown) => void)[] = []
  private exitListeners: ((c: number) => void)[] = []
  autoReady = true
  postMessage(m: any) {
    this.sent.push(m)
    if (m.type === 'init' && this.autoReady) queueMicrotask(() => this.reply({ type: 'ready' }))
    if (m.type === 'shutdown') queueMicrotask(() => this.reply({ type: 'shutdown-complete' }))
  }
  on(event: 'message' | 'exit', listener: any) {
    ;(event === 'message' ? this.messageListeners : this.exitListeners).push(listener)
    return this
  }
  kill() { this.crash(137); return true }
  reply(m: unknown) { for (const l of this.messageListeners) l(m) }
  crash(code: number) { for (const l of this.exitListeners) l(code) }
}

const init: AgentInit = {
  type: 'init', version: PROTOCOL_VERSION, cuaSdkPath: '/x/cua-sdk.mjs',
  cuaLibraryPath: '/x/libcua_driver_sdk.dylib', nativeHelperPath: '/x/JevNative', evidenceDir: '/x/evidence',
}
const options = { maxRestarts: 2, windowMs: 60_000, backoffMs: 1, readyTimeoutMs: 1_000 }

test('start sends init first and resolves on ready', async () => {
  const child = new FakeChild()
  const supervisor = new Supervisor(() => child, init, options)
  await supervisor.start()
  assert.equal(child.sent[0].type, 'init')
})

test('request resolves by id and failure rejects with the agent message', async () => {
  const child = new FakeChild()
  const supervisor = new Supervisor(() => child, init, options)
  await supervisor.start()
  const ok = supervisor.request('ping', {})
  const bad = supervisor.request('ping', {})
  const [a, b] = child.sent.filter((m) => m.type === 'request')
  child.reply({ type: 'result', id: a.id, value: { pong: true } })
  child.reply({ type: 'failure', id: b.id, error: 'nope' })
  assert.deepEqual(await ok, { pong: true })
  await assert.rejects(bad, /nope/)
})

test('crash rejects pending requests and restarts at most maxRestarts times', async () => {
  const children: FakeChild[] = []
  let gaveUp = ''
  const supervisor = new Supervisor(() => { const c = new FakeChild(); children.push(c); return c }, init, {
    ...options, onGiveUp: (reason) => { gaveUp = reason },
  })
  await supervisor.start()
  const pending = supervisor.request('ping', {})
  children[0].crash(1)
  await assert.rejects(pending, AgentExitedError)
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20))
    children.at(-1)!.crash(1)
  }
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(children.length, 3)
  assert.match(gaveUp, /restarted 2 times/)
})

test('a request times out with a clear error', async () => {
  const supervisor = new Supervisor(() => new FakeChild(), init, options)
  await supervisor.start()
  await assert.rejects(supervisor.request('ping', {}, { timeoutMs: 10 }), /did not answer ping within 10 ms/)
})

test('abort sends cancel to the agent and rejects', async () => {
  const child = new FakeChild()
  const supervisor = new Supervisor(() => child, init, options)
  await supervisor.start()
  const controller = new AbortController()
  const pending = supervisor.request('ping', {}, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  assert.ok(child.sent.some((m) => m.type === 'cancel'))
})

test('stop sends shutdown and resolves on shutdown-complete without killing', async () => {
  const child = new FakeChild()
  let killed = false
  child.kill = () => { killed = true; return true }
  const supervisor = new Supervisor(() => child, init, options)
  await supervisor.start()
  await supervisor.stop()
  assert.ok(child.sent.some((m) => m.type === 'shutdown'))
  assert.equal(killed, false)
})

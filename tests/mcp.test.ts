import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpProtocol, McpServer } from '../src/main/mcp'
import type { DriveResult } from '../src/shared/drive'

const rpc = (id: number | undefined, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) })
const ok: DriveResult = { ok: true, text: 'Window 7: TextEdit', image: 'aGk=' }

test('initialize, tools/list and ping follow MCP; notifications get no answer; bad input gets JSON-RPC errors', async () => {
  const p = new McpProtocol({ version: '0.0.1', call: async () => ok })
  const init = JSON.parse((await p.handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } })))!)
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
  assert.match(init.result.instructions, /pixels of the latest screenshot/)
  const future = JSON.parse((await p.handle(rpc(2, 'initialize', { protocolVersion: '2099-01-01' })))!)
  assert.equal(future.result.protocolVersion, '2025-11-25')
  assert.equal(await p.handle(rpc(undefined, 'notifications/initialized')), undefined)
  assert.deepEqual(JSON.parse((await p.handle(rpc(3, 'ping')))!).result, {})
  const list = JSON.parse((await p.handle(rpc(4, 'tools/list')))!).result.tools
  assert.deepEqual(list.map((t: { name: string }) => t.name), ['look', 'windows', 'open_app', 'open_url', 'click', 'type', 'keys', 'scroll', 'drag', 'wait', 'do', 'learn'])
  const click = list.find((t: { name: string }) => t.name === 'click').inputSchema
  assert.deepEqual(click.required, ['x', 'y'])
  assert.equal(click.additionalProperties, false)
  assert.equal(click.$schema, undefined)
  assert.equal(JSON.parse((await p.handle('{nope'))!).error.code, -32700)
  assert.equal(JSON.parse((await p.handle(rpc(5, 'resources/list')))!).error.code, -32601)
})

test('tools/call runs a checked call and returns its text and screenshot; anything invalid is an error result', async () => {
  const calls: unknown[] = []
  const p = new McpProtocol({ version: '0.0.1', call: async (c) => (calls.push(c), ok) })
  const done = JSON.parse((await p.handle(rpc(1, 'tools/call', { name: 'click', arguments: { x: 10, y: 20 } })))!).result
  assert.deepEqual(done, { content: [{ type: 'text', text: 'Window 7: TextEdit' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }], isError: false })
  assert.deepEqual(calls, [{ tool: 'click', x: 10, y: 20, button: 'left', count: 1, modifiers: [], screenshot: true }])
  const bad = JSON.parse((await p.handle(rpc(2, 'tools/call', { name: 'click', arguments: { x: 'ten' } })))!).result
  assert.equal(bad.isError, true)
  const unknown = JSON.parse((await p.handle(rpc(3, 'tools/call', { name: 'shell', arguments: { cmd: 'rm -rf ~' } })))!).result
  assert.equal(unknown.isError, true)
  assert.equal(calls.length, 1, 'nothing invalid reached JevAuto')
})

/** A line-based MCP client over the Unix socket, like `nc -U` in the plugin. */
async function client(path: string) {
  const socket = connect(path)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  let buffer = ''
  const waiting = new Map<number, (v: any) => void>()
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, i))
      buffer = buffer.slice(i + 1)
      waiting.get(m.id)?.(m)
    }
  })
  let n = 0
  const send = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = ++n
      waiting.set(id, resolve)
      socket.write(`${rpc(id, method, params)}\n`)
    })
  return { socket, send, look: async () => (await send('tools/call', { name: 'look', arguments: {} })).result }
}

test('the socket is yours only; the first client to act owns JevAuto until it leaves; Stop pauses every client', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'jevauto-mcp-')), 'sub')
  const path = join(dir, 'mcp.sock')
  let ends = 0
  const server = new McpServer({ socketPath: path, version: '0.0.1', call: async () => ok, end: () => void ends++ })
  await server.start()
  const a = await client(path)
  const b = await client(path)
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal((await a.look()).isError, false)
    assert.equal(server.driving, true)
    assert.match((await b.look()).content[0].text, /Another Claude Code session/)
    a.socket.end()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(ends, 1, 'the owner leaving ends JevAuto’s session')
    assert.equal((await b.look()).isError, false)
    server.pause(60_000)
    assert.match((await b.look()).content[0].text, /pressed Stop/)
  } finally {
    a.socket.destroy()
    b.socket.destroy()
    server.stop()
  }
})

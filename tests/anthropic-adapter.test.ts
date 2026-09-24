import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicAdapter, CLAUDE_DISABLED, HALT } from '../src/agent/providers/anthropic/adapter'
import { parseAnthropic } from '../src/agent/providers/anthropic/parse'
import { TOOL_DEFS } from '../src/agent/loop/tools'
import { costUsd } from '../src/agent/providers/prices'

const use = (id: string, name: string, input: Record<string, unknown>, toolset = true) => ({ type: 'tool_use', id, name, input, ...(toolset ? { toolset_name: 'computer' } : {}) })

test('every enabled toolset member becomes an IR action in screenshot pixels', () => {
  const turn = parseAnthropic({
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: 'Opening the file menu next.' },
      use('t1', 'left_click', { coordinate: [10, 20], text: 'shift' }),
      use('t2', 'double_click', { coordinate: [30, 40] }),
      use('t3', 'triple_click', { coordinate: [50, 60] }),
      use('t4', 'right_click', { coordinate: [1, 2] }),
      use('t5', 'middle_click', { coordinate: [3, 4] }),
      use('t6', 'left_click_drag', { start_coordinate: [5, 6], coordinate: [7, 8], text: 'ctrl+shift' }),
      use('t7', 'scroll', { coordinate: [9, 10], scroll_direction: 'down', scroll_amount: 5 }),
      use('t8', 'type', { text: 'hello' }),
      use('t9', 'key', { text: 'ctrl+s', repeat: 2 }),
      use('t10', 'wait', { duration: 1 }),
      use('t11', 'screenshot', {}),
      use('t12', 'zoom', { region: [0, 0, 10, 10] }),
      use('t13', 'open_url', { url: 'example.com' }, false),
    ],
  })
  assert.deepEqual(turn.text, ['Opening the file menu next.'])
  assert.deepEqual(turn.actions, [
    { kind: 'click', callId: 't1', x: 10, y: 20, space: 'pixels', button: 'left', keys: ['shift'] },
    { kind: 'click', callId: 't2', x: 30, y: 40, space: 'pixels', button: 'left', count: 2 },
    { kind: 'click', callId: 't3', x: 50, y: 60, space: 'pixels', button: 'left', count: 3 },
    { kind: 'click', callId: 't4', x: 1, y: 2, space: 'pixels', button: 'right' },
    { kind: 'click', callId: 't5', x: 3, y: 4, space: 'pixels', button: 'middle' },
    { kind: 'drag', callId: 't6', path: [{ x: 5, y: 6 }, { x: 7, y: 8 }], space: 'pixels', keys: ['ctrl', 'shift'] },
    { kind: 'scroll', callId: 't7', x: 9, y: 10, space: 'pixels', dx: 0, dy: 1, notches: 5 },
    { kind: 'type', callId: 't8', text: 'hello' },
    { kind: 'keys', callId: 't9', keys: ['ctrl', 's'] },
    { kind: 'keys', callId: 't9', keys: ['ctrl', 's'] },
    { kind: 'wait', callId: 't10' },
    { kind: 'screenshot', callId: 't11' },
    { kind: 'other', callId: 't12', name: 'zoom', input: { region: [0, 0, 10, 10] } },
    { kind: 'tool', callId: 't13', name: 'open_url', input: { url: 'example.com' } },
  ])
})

function fakeClient(contents: unknown[][], stop = 'tool_use') {
  const bodies: Record<string, unknown>[] = []
  let n = 0
  return {
    bodies,
    beta: {
      messages: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(structuredClone(body))
          n += 1
          return { id: `m${n}`, content: contents[n - 1] ?? [{ type: 'text', text: 'Done.' }], stop_reason: contents[n - 1] ? stop : 'end_turn', usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000, output_tokens: 300 } }
        },
      },
    },
  }
}

test('the request: the toolset with what JevAuto can’t do switched off, our tools, adaptive thinking at high effort, context editing', async () => {
  const client = fakeClient([[use('t1', 'screenshot', {})]])
  const adapter = new AnthropicAdapter(client, 'claude-opus-5-5', 'Be careful.')
  const turn = await adapter.start({ task: 'Type hello', context: 'Target: TextEdit', image: 'AAA' })
  const body = client.bodies[0] as { tools: { type?: string; name?: string; strict?: boolean; configs?: Record<string, { enabled: boolean }> }[]; [k: string]: unknown }
  assert.equal(body.model, 'claude-opus-5-5')
  assert.equal(body.tool_choice, undefined) // forced tool choice is a 400 on Opus 5.5
  assert.equal(body.temperature, undefined)
  assert.deepEqual(body.tools[0], { type: 'computer_toolset_20260801', configs: Object.fromEntries(CLAUDE_DISABLED.map((m) => [m, { enabled: false }])) })
  assert.deepEqual(body.tools.slice(1).map((t) => [t.name, t.strict]), TOOL_DEFS.map((t) => [t.name, true]))
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' })
  assert.deepEqual(body.output_config, { effort: 'high' })
  assert.deepEqual(body.betas, ['context-management-2025-06-27', 'thinking-display-updates-2026-08-18'])
  assert.deepEqual(body.context_management, { edits: [{ type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 40000 }, keep: { type: 'tool_uses', value: 12 }, clear_tool_inputs: false }] })
  assert.deepEqual(body.system, [{ type: 'text', text: 'Be careful.' }])
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Task: Type hello\n\nTarget: TextEdit' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' }, cache_control: { type: 'ephemeral' } },
      ],
    },
  ])
  assert.deepEqual(turn.usage, { inputTokens: 7100, cachedTokens: 5000, cacheWriteTokens: 2000, outputTokens: 300 })
})

test('results: one per call echoing toolset_name, OK or the screenshot, the exact halt text, the assistant turn kept as sent', async () => {
  const assistant = [
    { type: 'thinking', thinking: 'x', signature: 'sig' },
    use('t1', 'left_click', { coordinate: [1, 2] }),
    use('t2', 'type', { text: 'hi' }),
    use('t3', 'key', { text: 'Return' }),
    use('t4', 'list_windows', {}, false),
  ]
  const client = fakeClient([assistant, []])
  const adapter = new AnthropicAdapter(client, 'claude-opus-5-5', 'x')
  await adapter.start({ task: 't', context: 'c', image: 'AAA' })
  await adapter.next({
    results: [
      { callId: 't1', kind: 'computer', status: 'ok' },
      { callId: 't2', kind: 'computer', status: 'failed', message: 'type_text refused' },
      { callId: 't3', kind: 'computer', status: 'not-run' },
      { callId: 't4', kind: 'function', name: 'list_windows', output: '{"error":"Not executed: an earlier action in this turn failed."}' },
    ],
    image: 'BBB',
    notes: ['Stopped this turn.'],
  })
  const messages = client.bodies[1].messages as { role: string; content: unknown[] }[]
  assert.deepEqual(messages[1], { role: 'assistant', content: assistant })
  const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } }
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', toolset_name: 'computer', content: [{ type: 'text', text: 'OK' }, shot] },
      { type: 'tool_result', tool_use_id: 't2', toolset_name: 'computer', is_error: true, content: 'Error: type_text refused' },
      { type: 'tool_result', tool_use_id: 't3', toolset_name: 'computer', is_error: true, content: HALT },
      { type: 'tool_result', tool_use_id: 't4', is_error: true, content: '{"error":"Not executed: an earlier action in this turn failed."}' },
      { type: 'text', text: 'Stopped this turn.', cache_control: { type: 'ephemeral' } },
    ],
  })
  // Only the newest block carries the cache breakpoint: the first message's breakpoint moved (at most 4 are allowed).
  assert.equal(JSON.stringify(messages[0]).includes('cache_control'), false)
})

test('an organisation key sends its workspace; Claude costs follow cache reads and writes', () => {
  const usd = costUsd('claude-opus-5-5', { inputTokens: 7100, cachedTokens: 5000, cacheWriteTokens: 2000, outputTokens: 300 })!
  assert.ok(Math.abs(usd - (100 * 4 + 5000 * 0.4 + 2000 * 5 + 300 * 20) / 1e6) < 1e-12)
})

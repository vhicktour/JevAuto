import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiAdapter, GEMINI_EXCLUDED } from '../src/agent/providers/google/adapter'
import { parseGoogle } from '../src/agent/providers/google/parse'
import { TOOL_DEFS } from '../src/agent/loop/tools'
import { costUsd } from '../src/agent/providers/prices'

function fakeClient(steps: unknown[][]) {
  const bodies: Record<string, unknown>[] = []
  const deleted: string[] = []
  let n = 0
  return {
    bodies,
    deleted,
    interactions: {
      create: async (body: Record<string, unknown>) => {
        bodies.push(structuredClone(body))
        n += 1
        return { id: `i${n}`, steps: steps[n - 1] ?? [], usage: { total_input_tokens: 1117, raw_prompt_token: 4432, total_cached_tokens: 0, total_output_tokens: 31, total_thought_tokens: 2513 } }
      },
      delete: async (id: string) => void deleted.push(id),
    },
  }
}

test('every desktop action Gemini can send becomes an IR action on the 0-999 grid', () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'function_call', id, name, arguments: args })
  const turn = parseGoogle({
    steps: [
      call('g1', 'double_click', { x: 10, y: 20 }),
      call('g2', 'right_click', { x: 30, y: 40 }),
      call('g3', 'type', { text: 'hello', press_enter: true }),
      call('g4', 'scroll', { x: 500, y: 500, direction: 'down', magnitude_in_pixels: 600 }),
      call('g5', 'drag_and_drop', { start_x: 1, start_y: 2, end_x: 3, end_y: 4 }),
      call('g6', 'press_key', { key: 'Enter' }),
      call('g7', 'hotkey', { keys: ['command', 'b'] }),
      call('g8', 'wait', { seconds: 2 }),
      call('g9', 'navigate', { url: 'example.com' }),
      call('g10', 'list_windows', {}),
      call('g11', 'mouse_down', { x: 1, y: 1 }),
      call('g12', 'triple_click', { x: 50, y: 60 }),
    ],
  })
  assert.deepEqual(turn.actions, [
    { kind: 'click', callId: 'g1', x: 10, y: 20, space: 'normalized1000', button: 'left', count: 2 },
    { kind: 'click', callId: 'g2', x: 30, y: 40, space: 'normalized1000', button: 'right' },
    { kind: 'type', callId: 'g3', text: 'hello' },
    { kind: 'keys', callId: 'g3', keys: ['ENTER'] },
    { kind: 'scroll', callId: 'g4', x: 500, y: 500, space: 'normalized1000', dx: 0, dy: 600 },
    { kind: 'drag', callId: 'g5', path: [{ x: 1, y: 2 }, { x: 3, y: 4 }], space: 'normalized1000' },
    { kind: 'keys', callId: 'g6', keys: ['Enter'] },
    { kind: 'keys', callId: 'g7', keys: ['command', 'b'] },
    { kind: 'wait', callId: 'g8' },
    { kind: 'tool', callId: 'g9', name: 'open_url', input: { url: 'example.com' } },
    { kind: 'tool', callId: 'g10', name: 'list_windows', input: {} },
    { kind: 'other', callId: 'g11', name: 'mouse_down', input: { x: 1, y: 1 } },
    { kind: 'click', callId: 'g12', x: 50, y: 60, space: 'normalized1000', button: 'left', count: 3 },
  ])
})

test('the first request: desktop computer use with injection detection, our functions, the instructions, the screenshot', async () => {
  const client = fakeClient([[]])
  const adapter = new GeminiAdapter(client, 'gemini-3.8-flash', 'Be careful.')
  const turn = await adapter.start({ task: 'Type hello', context: 'Target: TextEdit', image: 'AAA' })
  const body = client.bodies[0]
  assert.equal(body.model, 'gemini-3.8-flash')
  assert.equal(body.system_instruction, 'Be careful.')
  assert.equal(body.previous_interaction_id, undefined)
  const tools = body.tools as { type: string; name?: string; environment?: string; enable_prompt_injection_detection?: boolean; excluded_predefined_functions?: string[] }[]
  assert.deepEqual(tools[0], { type: 'computer_use', environment: 'desktop', enable_prompt_injection_detection: true, excluded_predefined_functions: GEMINI_EXCLUDED })
  assert.deepEqual(tools.slice(1).map((t) => t.name), TOOL_DEFS.map((t) => t.name))
  assert.deepEqual(body.input, [
    { type: 'text', text: 'Task: Type hello\n\nTarget: TextEdit' },
    { type: 'image', data: 'AAA', mime_type: 'image/png' },
  ])
  assert.deepEqual(turn.usage, { inputTokens: 4432, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 2544 })
})

test('results: the screenshot first then the address (the API rejects the other order), names on every result', async () => {
  const client = fakeClient([[
    { type: 'function_call', id: 'g1', name: 'click', arguments: { x: 1, y: 2 } },
    { type: 'function_call', id: 'g2', name: 'navigate', arguments: { url: 'example.com' } },
  ], []])
  const adapter = new GeminiAdapter(client, 'gemini-3.8-flash', 'Be careful.')
  await adapter.start({ task: 't', context: 'c', image: 'AAA' })
  await adapter.next({
    results: [
      { callId: 'g1', kind: 'computer', acknowledged: [{ decision: 'require_confirmation' }] },
      { callId: 'g2', kind: 'function', name: 'open_url', output: '{"ok":true}' },
      { callId: 'f1', kind: 'function', name: 'list_windows', output: '{"windows":[]}' },
    ],
    image: 'BBB',
    url: 'https://example.com/',
    notes: ['Clicked.'],
  })
  const [first, second] = client.bodies
  assert.equal(second.previous_interaction_id, 'i1')
  assert.deepEqual(second.tools, first.tools)
  assert.equal(second.system_instruction, first.system_instruction)
  const shot = { type: 'image', data: 'BBB', mime_type: 'image/png' }
  assert.deepEqual(second.input, [
    { type: 'function_result', call_id: 'g1', name: 'click', result: [shot, { type: 'text', text: JSON.stringify({ url: 'https://example.com/', safety_acknowledgement: true }) }] },
    // Gemini's own navigate is answered like any computer action: with the screenshot, plus what open_url said.
    { type: 'function_result', call_id: 'g2', name: 'navigate', result: [shot, { type: 'text', text: JSON.stringify({ url: 'https://example.com/', result: { ok: true } }) }] },
    { type: 'function_result', call_id: 'f1', name: 'list_windows', result: '{"windows":[]}' },
    { type: 'text', text: 'Clicked.' },
  ])
})

test('stored interactions are deleted when the run ends (Gemini keeps them 55 days otherwise)', async () => {
  const client = fakeClient([[], []])
  const adapter = new GeminiAdapter(client, 'gemini-3.8-flash', 'x')
  await adapter.start({ task: 't', context: 'c' })
  await adapter.next({ results: [], notes: ['go on'] })
  await adapter.close()
  assert.deepEqual(client.deleted, ['i1', 'i2'])
})

test('Gemini cost counts thinking as output, at the published rates', () => {
  const usd = costUsd('gemini-3.8-flash', { inputTokens: 4432, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 2544 })!
  assert.ok(Math.abs(usd - (4432 * 0.75 + 2544 * 3.75) / 1e6) < 1e-12)
})

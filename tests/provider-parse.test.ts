import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAnthropic } from '../src/agent/providers/anthropic/parse'
import { parseOpenAI } from '../src/agent/providers/openai/parse'
import { parseGoogle } from '../src/agent/providers/google/parse'

test('Anthropic: toolset members become IR actions; custom tools stay "other"', () => {
  const turn = parseAnthropic({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Clicking Continue.' },
      { type: 'tool_use', id: 't1', name: 'screenshot', input: {}, toolset_name: 'computer' },
      { type: 'tool_use', id: 't2', name: 'left_click', input: { coordinate: [640, 412] }, toolset_name: 'computer' },
      { type: 'tool_use', id: 't3', name: 'list_windows', input: {} },
    ],
  })
  assert.deepEqual(turn.actions, [
    { kind: 'screenshot', callId: 't1' },
    { kind: 'click', callId: 't2', x: 640, y: 412, space: 'pixels', button: 'left' },
    { kind: 'other', callId: 't3', name: 'list_windows', input: {} },
  ])
  assert.deepEqual(turn.text, ['Clicking Continue.'])
})

test('Anthropic: a refusal is surfaced', () => {
  assert.equal(parseAnthropic({ stop_reason: 'refusal', content: [] }).refusal, true)
})

test('OpenAI: batched actions[], a single action, and pending safety checks', () => {
  const turn = parseOpenAI({
    output: [
      { type: 'computer_call', call_id: 'c1', pending_safety_checks: [{ id: 's1', code: 'malicious_instructions', message: 'x' }], actions: [{ type: 'click', button: 'left', x: 10, y: 20 }, { type: 'type', text: 'hi' }] },
      { type: 'computer_call', call_id: 'c2', pending_safety_checks: [], action: { type: 'screenshot' } },
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
    ],
  })
  assert.deepEqual(turn.actions[0], { kind: 'click', callId: 'c1', x: 10, y: 20, space: 'pixels', button: 'left' })
  assert.equal(turn.actions[1].kind, 'other')
  assert.deepEqual(turn.actions[2], { kind: 'screenshot', callId: 'c2' })
  assert.equal(turn.safety.length, 1)
  assert.deepEqual(turn.text, ['done'])
})

test('OpenAI: refusal content is surfaced', () => {
  assert.equal(parseOpenAI({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }).refusal, true)
})

test('Google: normalized clicks, screenshots, model text and require_confirmation', () => {
  const turn = parseGoogle({
    steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'Looking at the form.' }] },
      { type: 'function_call', id: 'g1', name: 'take_screenshot', arguments: {} },
      { type: 'function_call', id: 'g2', name: 'click', arguments: { x: 500, y: 450, intent: 'Continue', safety_decision: { decision: 'require_confirmation', explanation: 'purchase' } } },
    ],
  })
  assert.deepEqual(turn.actions, [
    { kind: 'screenshot', callId: 'g1' },
    { kind: 'click', callId: 'g2', x: 500, y: 450, space: 'normalized1000', button: 'left' },
  ])
  assert.equal(turn.safety[0].provider, 'google')
  assert.deepEqual(turn.text, ['Looking at the form.', 'Continue'])
})

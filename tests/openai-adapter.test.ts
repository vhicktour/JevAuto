import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIAdapter, OPENAI_CLIENT_OPTIONS } from '../src/agent/providers/openai/adapter'
import { TOOL_DEFS } from '../src/agent/loop/tools'
import { costUsd } from '../src/agent/providers/prices'

function fakeClient(outputs: unknown[][]) {
  const bodies: Record<string, unknown>[] = []
  let n = 0
  return {
    bodies,
    responses: {
      create: async (body: Record<string, unknown>) => {
        bodies.push(structuredClone(body))
        n += 1
        return {
          id: `resp_${n}`,
          output: outputs[n - 1] ?? [],
          usage: { input_tokens: 3270, input_tokens_details: { cached_tokens: 2039, cache_write_tokens: 1228 }, output_tokens: 31 },
        }
      },
    },
  }
}

test('the first request carries the task, the fixed tools and instructions, and the screenshot at original detail', async () => {
  const client = fakeClient([[{ type: 'computer_call', call_id: 'c1', actions: [{ type: 'screenshot' }], pending_safety_checks: [] }]])
  const adapter = new OpenAIAdapter(client, 'gpt-6-sol', 'Be careful.')
  const turn = await adapter.start({ task: 'Type hello', context: 'Target: TextEdit', image: 'AAA' })
  const body = client.bodies[0]
  assert.equal(body.model, 'gpt-6-sol')
  assert.equal(body.instructions, 'Be careful.')
  assert.equal(body.previous_response_id, undefined)
  assert.deepEqual((body.tools as unknown[])[0], { type: 'computer' })
  assert.deepEqual(
    (body.tools as { name?: string }[]).slice(1).map((t) => t.name),
    TOOL_DEFS.map((t) => t.name),
  )
  for (const t of (body.tools as { type: string; strict?: boolean }[]).slice(1)) assert.deepEqual([t.type, t.strict], ['function', true])
  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Task: Type hello\n\nTarget: TextEdit' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'original' },
      ],
    },
  ])
  assert.deepEqual(turn.actions, [{ kind: 'screenshot', callId: 'c1' }])
  assert.equal(turn.id, 'resp_1')
  assert.deepEqual(turn.usage, { inputTokens: 3270, cachedTokens: 2039, cacheWriteTokens: 1228, outputTokens: 31 })
})

test('a start without a target sends text only', async () => {
  const client = fakeClient([[]])
  await new OpenAIAdapter(client, 'gpt-6-sol', 'x').start({ task: 'Open Notes', context: 'No window is selected.' })
  assert.deepEqual(client.bodies[0].input, [{ role: 'user', content: [{ type: 'input_text', text: 'Task: Open Notes\n\nNo window is selected.' }] }])
})

test('every call is answered: screenshots for computer calls, text for functions, notes last, same tools and instructions', async () => {
  const client = fakeClient([
    [
      { type: 'computer_call', call_id: 'c1', actions: [{ type: 'click', button: 'left', x: 1, y: 2 }], pending_safety_checks: [{ id: 's1', code: 'x', message: 'y' }] },
      { type: 'function_call', call_id: 'f1', name: 'list_windows', arguments: '{}' },
    ],
    [],
  ])
  const adapter = new OpenAIAdapter(client, 'gpt-6-sol', 'Be careful.')
  await adapter.start({ task: 't', context: 'c', image: 'AAA' })
  await adapter.next({
    results: [
      { callId: 'c1', kind: 'computer', acknowledged: [{ id: 's1', code: 'x', message: 'y' }] },
      { callId: 'f1', kind: 'function', name: 'list_windows', output: '{"windows":[]}' },
    ],
    image: 'BBB',
    notes: ['Ran: click.', 'Not run: nothing.'],
  })
  const [first, second] = client.bodies
  assert.equal(second.previous_response_id, 'resp_1')
  assert.deepEqual(second.tools, first.tools)
  assert.equal(second.instructions, first.instructions)
  assert.deepEqual(second.input, [
    {
      type: 'computer_call_output',
      call_id: 'c1',
      output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,BBB', detail: 'original' },
      acknowledged_safety_checks: [{ id: 's1', code: 'x', message: 'y' }],
    },
    { type: 'function_call_output', call_id: 'f1', output: '{"windows":[]}' },
    { role: 'user', content: [{ type: 'input_text', text: 'Ran: click.\nNot run: nothing.' }] },
  ])
})

test('a computer call answered without acknowledgement carries no acknowledged_safety_checks', async () => {
  const client = fakeClient([[{ type: 'computer_call', call_id: 'c1', actions: [{ type: 'wait' }] }], []])
  const adapter = new OpenAIAdapter(client, 'gpt-6-sol', 'x')
  await adapter.start({ task: 't', context: 'c', image: 'AAA' })
  await adapter.next({ results: [{ callId: 'c1', kind: 'computer' }], image: 'BBB', notes: [] })
  assert.deepEqual(client.bodies[1].input, [
    { type: 'computer_call_output', call_id: 'c1', output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,BBB', detail: 'original' } },
  ])
})

test('a computer result without a screenshot is a programming error, not a silent blank', async () => {
  const client = fakeClient([[{ type: 'computer_call', call_id: 'c1', actions: [{ type: 'wait' }] }]])
  const adapter = new OpenAIAdapter(client, 'gpt-6-sol', 'x')
  await adapter.start({ task: 't', context: 'c' })
  await assert.rejects(adapter.next({ results: [{ callId: 'c1', kind: 'computer' }], notes: [] }), /screenshot/)
})

test('cost follows OpenAI usage: uncached, cached and cache-write input are priced separately', () => {
  const usage = { inputTokens: 3270, cachedTokens: 2039, cacheWriteTokens: 1228, outputTokens: 31 }
  const expected = (3 * 2 + 2039 * 0.2 + 1228 * 2.5 + 31 * 10) / 1e6
  assert.ok(Math.abs(costUsd('gpt-6-sol', usage)! - expected) < 1e-12)
  assert.equal(costUsd('no-such-model', usage), undefined)
})

test('a model request that hangs is cut off; JevAuto, not the SDK, decides what to retry', () => {
  assert.deepEqual(OPENAI_CLIENT_OPTIONS, { timeout: 90_000, maxRetries: 0 })
})

function flaky(errors: unknown[]) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    responses: {
      create: async () => {
        calls += 1
        const e = errors.shift()
        if (e) throw e
        return { id: 'r1', output: [], usage: {} }
      },
    },
  }
}

test('a rate limit or a server error is retried; an empty balance or a bad key fails at once', async () => {
  const retried = flaky([Object.assign(new Error('429'), { status: 429, code: 'rate_limit_exceeded' }), Object.assign(new Error('503'), { status: 503 })])
  await new OpenAIAdapter(retried, 'gpt-6-sol', 'x', 1).start({ task: 't', context: 'c' })
  assert.equal(retried.calls, 3)
  const broke = flaky([Object.assign(new Error('429'), { status: 429, type: 'insufficient_quota', code: 'credit_balance_exhausted' })])
  await assert.rejects(new OpenAIAdapter(broke, 'gpt-6-sol', 'x', 1).start({ task: 't', context: 'c' }), /429/)
  assert.equal(broke.calls, 1)
})

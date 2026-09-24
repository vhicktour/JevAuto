import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainError, shouldRetry } from '../src/agent/providers/errors'

const api = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${status}`), { status, ...extra })

test('an empty OpenAI balance says so and how to fix it, instead of "rate limit"', () => {
  const e = api(429, { type: 'insufficient_quota', code: 'credit_balance_exhausted' })
  assert.match(explainError('openai', e), /out of credits/i)
  assert.match(explainError('openai', e), /Billing/)
  assert.equal(shouldRetry(e), false)
})

test('each provider failure gets its own plain message', () => {
  assert.match(explainError('openai', api(429, { code: 'rate_limit_exceeded' })), /rate limit/i)
  assert.match(explainError('openai', api(401)), /rejected the API key.*OPENAI_API_KEY/)
  assert.match(explainError('anthropic', api(401)), /ANTHROPIC_API_KEY/)
  assert.match(explainError('google', api(403)), /GEMINI_API_KEY/)
  assert.match(explainError('openai', api(404, { code: 'model_not_found' })), /model/i)
  assert.match(explainError('openai', api(503)), /server error/i)
  assert.match(explainError('openai', Object.assign(new Error('fetch failed'), { name: 'APIConnectionError' })), /reach OpenAI/)
  assert.match(explainError('openai', new Error('something odd')), /something odd/)
})

test('only failures that can pass on their own are retried', () => {
  for (const e of [api(429, { code: 'rate_limit_exceeded' }), api(500), api(503), api(408), Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' })]) assert.equal(shouldRetry(e), true)
  for (const e of [api(400), api(401), api(403), api(404), api(429, { code: 'insufficient_quota' })]) assert.equal(shouldRetry(e), false)
})

test('an Anthropic organisation key without its workspace says which setting is missing', () => {
  const e = Object.assign(new Error('400 {"error":{"message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}'), { status: 400 })
  assert.match(explainError('anthropic', e), /ANTHROPIC_WORKSPACE_ID/)
})

test('Anthropic reports an empty balance as a 400; it still reads as out of credits and is not retried', () => {
  const e = Object.assign(new Error('400 {"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 })
  assert.match(explainError('anthropic', e), /out of credits.*console\.anthropic\.com/)
  assert.equal(shouldRetry(e), false)
})

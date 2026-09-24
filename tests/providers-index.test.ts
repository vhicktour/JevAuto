import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adapterFor } from '../src/agent/providers'

test('the model name picks the provider, and a missing key or an unknown model says what to do', () => {
  assert.equal(adapterFor('gpt-6-sol', 'x', { openai: 'k' }).provider, 'openai')
  assert.equal(adapterFor('gemini-3.8-flash', 'x', { google: 'k' }).provider, 'google')
  assert.throws(() => adapterFor('gemini-3.8-flash', 'x', { openai: 'k' }), /GEMINI_API_KEY/)
  assert.throws(() => adapterFor('gpt-6-sol', 'x', {}), /OPENAI_API_KEY/)
  assert.throws(() => adapterFor('mystery-1', 'x', { openai: 'k' }), /no adapter/)
})

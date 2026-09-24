import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keysFromEnvFile } from '../src/main/keys'

test('provider keys come from .env.local lines; blanks, comments and other variables are ignored', () => {
  const text = ['# keys', 'OPENAI_API_KEY=sk-test-1', 'ANTHROPIC_API_KEY="ant-2"', 'ANTHROPIC_WORKSPACE_ID=', 'GEMINI_API_KEY=g-3', 'TYPESAFE_API_KEY=t-4', 'PATH=/tmp'].join('\n')
  assert.deepEqual(keysFromEnvFile(text), { openai: 'sk-test-1', anthropic: 'ant-2', google: 'g-3', typesafe: 't-4' })
  assert.deepEqual(keysFromEnvFile(''), {})
})

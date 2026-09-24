import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentArgs, answerOf, avoidBundles } from '../scripts/agent-args'

test('the task and the flags become run options with the default budget filled in', () => {
  assert.deepEqual(parseAgentArgs(['Type hello', '--max-actions', '10', '--budget', '0.5', '--watch', '--exclude', 'Slack', '--exclude', 'com.apple.mail']), {
    task: 'Type hello',
    model: 'gpt-6-sol',
    budget: { maxActions: 10, maxMs: 360_000, maxUsd: 0.5 },
    watch: true,
    excluded: ['Slack', 'com.apple.mail'],
  })
  assert.deepEqual(parseAgentArgs(['Do', 'the', 'thing', '--minutes', '2']).task, 'Do the thing')
  assert.equal(parseAgentArgs(['x', '--minutes', '2']).budget.maxMs, 120_000)
})

test('a missing task or a bad number is an error, not a guess', () => {
  assert.throws(() => parseAgentArgs([]), /task/)
  assert.throws(() => parseAgentArgs(['x', '--max-actions', 'lots']), /max-actions/)
  assert.throws(() => parseAgentArgs(['x', '--budget', '-1']), /budget/)
})

test('only y allows; a for-this-run answer only where it is offered; anything else denies', () => {
  assert.equal(answerOf('y', false), 'once')
  assert.equal(answerOf(' YES ', false), 'once')
  assert.equal(answerOf('a', true), 'run')
  assert.equal(answerOf('a', false), 'deny')
  assert.equal(answerOf('', true), 'deny')
  assert.equal(answerOf('sure', true), 'deny')
})

test('the terminal running the CLI is never the first target', () => {
  const avoid = avoidBundles({ __CFBundleIdentifier: 'com.mitchellh.ghostty' })
  assert.ok(avoid.includes('com.mitchellh.ghostty'))
  assert.ok(avoid.includes('com.apple.Terminal'))
  assert.ok(avoid.includes('com.googlecode.iterm2'))
})

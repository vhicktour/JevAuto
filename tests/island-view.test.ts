import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narrate, reduceIsland, REST } from '../src/renderer/src/island-view'
import type { UiAct } from '../src/shared/ui-events'

const act = (a: Partial<UiAct>): UiAct => ({ id: 'a1', verb: 'click', visible: true, ...a })

test('narration names the action, the target and the app in plain words', () => {
  assert.equal(narrate(act({ label: '7', app: 'Calculator' })), 'Clicking “7” in Calculator')
  assert.equal(narrate(act({ verb: 'type', label: '“Hello”', app: 'TextEdit' })), 'Typing “Hello” in TextEdit')
  assert.equal(narrate(act({ verb: 'key', label: 'return' })), 'Pressing return')
  assert.equal(narrate(act({ verb: 'launch', label: 'Calculator' })), 'Opening Calculator')
  assert.equal(narrate(act({ label: 'Add one', app: 'Electron', visible: false })), 'Working in Electron')
})

test('the island rests until work starts, narrates each action, and shows the step', () => {
  let view = reduceIsland(REST, { type: 'status', status: { state: 'working', title: 'Demo', step: { n: 1, of: 6 } } })
  assert.equal(view.mode, 'working')
  assert.deepEqual(view.step, { n: 1, of: 6 })
  view = reduceIsland(view, { type: 'act', act: act({ label: '7', app: 'Calculator' }) })
  assert.equal(view.detail, 'Clicking “7” in Calculator')
  view = reduceIsland(view, { type: 'status', status: { state: 'done', title: 'Done · 6 steps' } })
  assert.equal(view.mode, 'done')
  assert.equal(reduceIsland(view, { type: 'status', status: { state: 'idle', title: '' } }).mode, 'rest')
})

test('needs-you, errors and Stop each get their own mode', () => {
  assert.equal(reduceIsland(REST, { type: 'status', status: { state: 'needs-you', title: 'Allow the send?' } }).mode, 'attention')
  assert.equal(reduceIsland(REST, { type: 'status', status: { state: 'error', title: 'Calculator quit' } }).mode, 'error')
  assert.equal(reduceIsland(REST, { type: 'status', status: { state: 'stopped', title: 'Stopped' } }).mode, 'stopped')
})

test('an action while resting does not wake the island by itself', () => {
  assert.equal(reduceIsland(REST, { type: 'act', act: act({ label: '7' }) }).mode, 'rest')
})

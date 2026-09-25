import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narrate, reduceIsland, REST } from '../src/renderer/src/island-view'
import { UiView, type UiAct } from '../src/shared/ui-events'

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

test('an approval shows on the island until it is answered or expires', () => {
  const approval = { id: 'p1', kind: 'action' as const, title: 'Click “Send” in Mail', reason: 'It sends the message.', offersRun: false }
  let view = reduceIsland(REST, { type: 'status', status: { state: 'working', title: 'Write the email' } })
  view = reduceIsland(view, { type: 'approval', approval })
  assert.equal(view.mode, 'attention')
  assert.deepEqual(view.approval, approval)
  assert.equal(reduceIsland(view, { type: 'approval-closed', id: 'other' }).approval, approval)
  view = reduceIsland(view, { type: 'approval-closed', id: 'p1' })
  assert.equal(view.approval, undefined)
})

const working = reduceIsland(REST, { type: 'status', status: { state: 'working', title: 'Make it bold' } })
const shot = { app: 'TextEdit', title: 'Notes.rtf', image: 'aGVsbG8=' }

test('the island keeps the latest picture of the target, and shows it while the cursor cannot', () => {
  let view = reduceIsland(working, { type: 'view', view: shot })
  assert.deepEqual(view.preview, shot)
  assert.equal(view.hidden, undefined)
  view = reduceIsland(view, { type: 'act', act: act({ id: 'a1', label: 'Bold', app: 'TextEdit', visible: false }) })
  assert.equal(view.hidden, true)
  view = reduceIsland(view, { type: 'act', act: act({ id: 'a2', verb: 'key', label: 'cmd+b', visible: false }) })
  assert.equal(view.hidden, true, 'a key press has no point either way; it keeps the last answer')
  view = reduceIsland(view, { type: 'act', act: act({ id: 'a3', label: 'Bold', app: 'TextEdit', visible: true }) })
  assert.equal(view.hidden, false)
  assert.equal(reduceIsland(view, { type: 'status', status: { state: 'idle', title: '' } }).preview, undefined)
})

test('the timeline lists the run\'s last six steps in full words, marks each result, and starts over with a new run', () => {
  let view = working
  for (let i = 1; i <= 7; i++) view = reduceIsland(view, { type: 'act', act: act({ id: `a${i}`, label: `B${i}`, app: 'TextEdit', visible: i !== 7 }) })
  assert.deepEqual(view.steps?.map((s) => s.id), ['a2', 'a3', 'a4', 'a5', 'a6', 'a7'])
  assert.equal(view.steps?.at(-1)?.text, 'Clicking “B7” in TextEdit', 'a hidden step is still named in the timeline')
  view = reduceIsland(view, { type: 'done', done: { id: 'a6', ok: true, ms: 40 } })
  view = reduceIsland(view, { type: 'done', done: { id: 'a7', ok: false, ms: 40 } })
  assert.deepEqual(view.steps?.slice(-2).map((s) => s.ok), [true, false])
  // Back to working after an approval is the same run; after the run ended it is a new one.
  view = reduceIsland(view, { type: 'status', status: { state: 'needs-you', title: 'Send?' } })
  view = reduceIsland(view, { type: 'status', status: { state: 'working', title: 'Make it bold' } })
  assert.equal(view.steps?.length, 6)
  view = reduceIsland(view, { type: 'status', status: { state: 'done', title: 'Done' } })
  assert.equal(view.steps?.length, 6, 'the finished run stays readable')
  view = reduceIsland(view, { type: 'status', status: { state: 'working', title: 'Next task' } })
  assert.deepEqual(view.steps, [])
})

test('narration can name a hidden step in full, for the history', () => {
  assert.equal(narrate(act({ label: 'Bold', app: 'TextEdit', visible: false }), true), 'Clicking “Bold” in TextEdit')
})

test('a picture from the agent must be plain base64 of a bounded size', () => {
  assert.equal(UiView.safeParse(shot).success, true)
  assert.equal(UiView.safeParse({ ...shot, image: 'aGVsbG8=" onerror="x' }).success, false)
  assert.equal(UiView.safeParse({ ...shot, image: 'A'.repeat(400_001) }).success, false)
})

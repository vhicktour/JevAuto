import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsOf, windowStateOf, findElement, jsonSafe } from '../src/agent/mac/results'

test('windowsOf reads the documented list_windows shape and tolerates extra fields', () => {
  const windows = windowsOf({ windows: [{ window_id: 42, pid: 7, app_name: 'TextEdit', title: 'spike-a-1.txt', bounds: { x: 1, y: 2, width: 3, height: 4 }, z_index: 0, is_on_screen: true, space_ids: [1] }] })
  assert.equal(windows[0].window_id, 42)
  assert.equal(windows[0].title, 'spike-a-1.txt')
})

test('windowsOf returns [] for an unknown shape instead of throwing', () => {
  assert.deepEqual(windowsOf({ something: 'else' }), [])
})

test('windowStateOf and findElement pick the text area by role', () => {
  const state = windowStateOf({
    snapshot_id: 's1',
    elements: [
      { element_index: 0, role: 'AXWindow', label: 'spike-a-1.txt', depth: 0 },
      { element_index: 5, role: 'AXTextArea', label: null, value: 'hello', actions: ['AXPress'], depth: 3 },
    ],
  })
  assert.equal(state.snapshotId, 's1')
  assert.equal(findElement(state.elements, 'AXTextArea')?.element_index, 5)
  assert.equal(findElement(state.elements, 'AXButton', 'Cancel'), undefined)
})

test('jsonSafe turns bigint window ids into strings', () => {
  assert.deepEqual(jsonSafe({ id: 12n, nested: [1n] }), { id: '12', nested: ['1'] })
})

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

test("windowStateOf reads Cua 0.28's {x, y, w, h} frames and keeps every parseable element", () => {
  const state = windowStateOf({
    snapshot_id: 's00000002',
    elements: [
      { actions: ['AXPress', 'AXShowMenu'], depth: 2, element_index: 2, element_token: 's00000002:2', enabled: true, frame: { h: 49, w: 120, x: 602, y: 401 }, in_web_content: true, label: 'Add one', parent_index: 1, role: 'AXButton', selected: false },
      { role: 'AXGroup', label: 'no index, so not actionable' },
      { actions: ['AXPress'], depth: 2, element_index: 4, frame: { h: 68, w: 344, x: 643, y: 466 }, label: 'Notes', role: 'AXTextArea' },
    ],
  })
  assert.equal(state.elements.length, 2)
  assert.deepEqual(findElement(state.elements, 'AXButton', 'Add one')?.frame, { x: 602, y: 401, width: 120, height: 49 })
  assert.equal(findElement(state.elements, 'AXTextArea', 'Notes')?.element_index, 4)
})

test('after five idle minutes Cua ends its session; the next call opens a fresh one and still answers', async () => {
  const { MacDriver } = await import('../src/agent/mac/cua')
  const made: { calls: string[] }[] = []
  const toolResult = (isError: boolean, errorCode?: string) => ({ text: isError ? 'this session has ended; call start_session explicitly to reuse its label' : 'ok', images: [], structuredJson: '{}', rawJson: '{}', isError, errorCode })
  const cua = {
    DriverOptions: { new: () => ({}) },
    CuaDriver: {
      create: () => {
        const driver = { calls: [] as string[] }
        made.push(driver)
        const expired = made.length === 1
        return Object.assign(driver, {
          callTool: async (name: string) => (driver.calls.push(name), expired && name !== 'probe' ? toolResult(true, 'session_ended') : toolResult(false)),
          shutdown: async () => {},
        })
      },
    },
  }
  const mac = MacDriver.open(cua as never)
  const r = await mac.call('list_windows', {})
  assert.equal(r.isError, false)
  assert.equal(made.length, 2, 'a fresh driver session was opened')
  assert.deepEqual(made.map((d) => d.calls), [['list_windows'], ['list_windows']])
})

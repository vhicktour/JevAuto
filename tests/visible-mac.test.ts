import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VisibleMac, isPointVisible, type Mac } from '../src/agent/mac/visible'
import { windowsOf } from '../src/agent/mac/results'
import type { CuaResult } from '../src/agent/mac/cua'

const result = (structured: unknown, isError = false): CuaResult => ({ text: isError ? 'failed' : 'ok', imageCount: 0, images: [], structured, isError, durationMs: 5 })

const calculator = { window_id: 7, pid: 3, app_name: 'Calculator', title: 'Calculator', bounds: { x: 50, y: 60, width: 400, height: 300 }, z_index: 12, layer: 0, is_on_screen: true }
const state = {
  snapshot_id: 's00000001',
  window_id: 7,
  pid: 3,
  app_name: 'Calculator',
  window_bounds: { x: 50, y: 60, width: 400, height: 300 },
  screenshot_width: 800,
  elements: [{ element_index: 4, role: 'AXButton', label: '7', frame: { x: 100, y: 200, w: 40, h: 30 } }],
}

/** A driver stand-in: answers by tool name and records the order of everything that happened. */
function fakeMac(windows: unknown[] = [calculator], failing = new Set<string>()) {
  const log: string[] = []
  const mac: Mac = {
    async call(name, args) {
      log.push(`call ${name}`)
      if (name === 'get_window_state') return result(state)
      if (name === 'list_windows') return result({ windows })
      if (name === 'get_screen_size') return result({ width: 2056, height: 1329, scale_factor: 2 })
      return result({ args }, failing.has(name))
    },
    async close() {},
  }
  return { mac, log }
}

function visible(windows?: unknown[], failing?: Set<string>) {
  const { mac, log } = fakeMac(windows, failing)
  const events: { name: string; data: any }[] = []
  let n = 0
  const v = new VisibleMac(mac, (name, data) => { log.push(`emit ${name}`); events.push({ name, data }) }, () => `a${++n}`)
  return { v, log, events }
}

test('isPointVisible: frontmost target yes; covered, off-screen or outside no; floating panels ignored', () => {
  const ws = windowsOf({ windows: [
    calculator,
    { window_id: 9, pid: 5, title: 'Browser', bounds: { x: 300, y: 0, width: 500, height: 500 }, z_index: 20, layer: 0, is_on_screen: true },
    { window_id: 11, pid: 6, title: 'Overlay', bounds: { x: 0, y: 0, width: 2000, height: 2000 }, z_index: 99, layer: 1000, is_on_screen: true },
  ] })
  assert.equal(isPointVisible({ x: 120, y: 215 }, 7, ws), true) // under the overlay panel only
  assert.equal(isPointVisible({ x: 320, y: 215 }, 7, ws), false) // the browser (z 20) covers it
  assert.equal(isPointVisible({ x: 20, y: 20 }, 7, ws), false) // not inside the target window
  assert.equal(isPointVisible({ x: 120, y: 215 }, 42, ws), false) // target not on screen
})

test('an element click is announced with its screen rect before the driver acts, then marked done', async () => {
  const { v, log, events } = visible()
  await v.call('get_window_state', { pid: 3, window_id: 7 })
  await v.call('click', { pid: 3, window_id: 7, element_index: 4, snapshot_id: 's00000001' })
  assert.deepEqual(events[0], {
    name: 'ui.act',
    data: { id: 'a1', verb: 'click', label: '7', app: 'Calculator', rect: { x: 100, y: 200, width: 40, height: 30 }, point: { x: 120, y: 215 }, visible: true },
  })
  assert.equal(events[1].name, 'ui.done')
  assert.equal(events[1].data.ok, true)
  assert.ok(log.indexOf('emit ui.act') < log.indexOf('call click'), log.join(' | '))
})

test('a pixel click maps window screenshot pixels back to screen points', async () => {
  const { v, events } = visible()
  await v.call('get_window_state', { pid: 3, window_id: 7 })
  await v.call('click', { pid: 3, window_id: 7, x: 200, y: 100 })
  assert.deepEqual(events[0].data.point, { x: 150, y: 110 }) // 800 px across a 400 pt window: half a point per pixel
  assert.equal(events[0].data.visible, true)
})

test('a covered target is announced without a cursor', async () => {
  const cover = { window_id: 9, pid: 5, title: 'Browser', bounds: { x: 0, y: 0, width: 1000, height: 1000 }, z_index: 30, layer: 0, is_on_screen: true }
  const { v, events } = visible([calculator, cover])
  await v.call('get_window_state', { pid: 3, window_id: 7 })
  await v.call('click', { pid: 3, window_id: 7, element_index: 4, snapshot_id: 's00000001' })
  assert.equal(events[0].data.visible, false)
  assert.equal(events[0].data.app, 'Calculator')
})

test('keys are narrated without a point; reads pass through silently; failures are marked', async () => {
  const { v, events } = visible(undefined, new Set(['press_key']))
  await v.call('list_windows', {})
  await v.call('check_permissions', { prompt: false })
  assert.equal(events.length, 0)
  await v.call('press_key', { pid: 3, window_id: 7, key: 'return' })
  assert.deepEqual(events[0].data, { id: 'a1', verb: 'key', label: 'return', app: 'Calculator', visible: false })
  assert.equal(events[1].data.ok, false)
})

test('clicks carry their count, button and held keys; typing its text; scrolling its direction', async () => {
  const { v, events } = visible()
  await v.call('get_window_state', { pid: 3, window_id: 7 })
  await v.call('click', { pid: 3, window_id: 7, x: 200, y: 100, count: 2, button: 'right', modifier: ['shift'] })
  await v.call('type_text', { pid: 3, window_id: 7, element_index: 4, snapshot_id: 's00000001', text: 'Hello there' })
  await v.call('scroll', { pid: 3, window_id: 7, x: 200, y: 100, direction: 'down', amount: 3 })
  const acts = events.filter((e) => e.name === 'ui.act').map((e) => e.data)
  assert.deepEqual([acts[0].count, acts[0].button, acts[0].held], [2, 'right', ['shift']])
  assert.equal(acts[1].text, 'Hello there')
  assert.equal(acts[2].direction, 'down')
})

test('in Watch mode each visible action waits for the cursor to arrive, so the click lands as the cursor presses', async () => {
  const { v } = visible()
  await v.call('get_window_state', { pid: 3, window_id: 7 })
  const t0 = performance.now()
  await v.call('click', { pid: 3, window_id: 7, element_index: 4, snapshot_id: 's00000001' })
  const unpaced = performance.now() - t0
  v.pace = true
  const t1 = performance.now()
  await v.call('click', { pid: 3, window_id: 7, element_index: 4, snapshot_id: 's00000001' })
  const paced = performance.now() - t1
  assert.ok(unpaced < 60, `background mode never waits (${unpaced} ms)`)
  // Same point twice: no travel, only the dwell before the press.
  assert.ok(paced >= 70 && paced < 400, `paced ${paced} ms`)
})

test('a paced wait ends at once on Stop', async () => {
  const { v } = visible()
  v.pace = true
  await v.call('get_window_state', { pid: 3, window_id: 7 })
  const controller = new AbortController()
  const t0 = performance.now()
  const pending = v.call('click', { pid: 3, window_id: 7, x: 790, y: 590 }, controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending)
  assert.ok(performance.now() - t0 < 200)
})

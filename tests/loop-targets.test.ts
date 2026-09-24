import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Targets } from '../src/agent/loop/targets'
import type { Mac } from '../src/agent/mac/visible'
import type { CuaResult } from '../src/agent/mac/cua'

type W = { window_id: number; pid: number; app_name: string; title: string; bounds: { x: number; y: number; width: number; height: number }; z_index: number }
const ok = (structured: unknown): CuaResult => ({ text: 'ok', imageCount: 0, images: [], structured, isError: false, durationMs: 1 })
const orb = { window_id: 2, pid: 5, app_name: 'TextEdit', title: '', bounds: { x: 0, y: 0, width: 280, height: 168 }, z_index: 9 }
const doc = { window_id: 1, pid: 5, app_name: 'TextEdit', title: 'notes.txt', bounds: { x: 0, y: 0, width: 656, height: 422 }, z_index: 8 }
const alert = { window_id: 3, pid: 5, app_name: 'TextEdit', title: '', bounds: { x: 0, y: 0, width: 260, height: 300 }, z_index: 10 }
const ELEMENTS: Record<number, unknown[]> = {
  2: [{ element_index: 0, role: 'AXWindow' }, { element_index: 1, role: 'AXButton', label: 'Siri Waveform Orb' }],
  3: [{ element_index: 0, role: 'AXWindow' }, { element_index: 1, role: 'AXButton', label: 'Save' }, { element_index: 2, role: 'AXButton', label: 'Don’t Save' }],
}

function mac(windows: W[]): Mac & { windows: W[]; states: number } {
  const m = {
    windows,
    states: 0,
    async call(name: string, args: Record<string, unknown>) {
      if (name === 'list_apps') return ok({ apps: [{ pid: 5, bundle_id: 'com.apple.TextEdit', name: 'TextEdit', running: true }] })
      if (name === 'list_windows') return ok({ windows: m.windows.map((w) => ({ ...w, layer: 0, is_on_screen: true })) })
      if (name === 'get_window_state') {
        m.states += 1
        return ok({ snapshot_id: 'x', elements: ELEMENTS[args.window_id as number] ?? [] })
      }
      return ok({})
    },
    async close() {},
  }
  return m
}

test('an untitled helper window with a single control is never picked as the target', async () => {
  const m = mac([orb, doc])
  const targets = new Targets(m)
  assert.equal((await targets.initial([]))?.windowId, 1)
})

test('a new untitled window with real controls (an alert, a sheet) is followed; a new orb is not', async () => {
  const m = mac([doc])
  const targets = new Targets(m)
  await targets.windows()
  m.windows = [orb, doc]
  assert.equal(await targets.follow({ pid: 5, windowId: 1, app: 'TextEdit' }), undefined)
  m.windows = [alert, orb, doc]
  assert.equal((await targets.follow({ pid: 5, windowId: 1, app: 'TextEdit' }))?.windowId, 3)
})

test('each untitled window is inspected once per run', async () => {
  const m = mac([orb, doc])
  const targets = new Targets(m)
  await targets.windows()
  await targets.windows()
  assert.equal(m.states, 1)
})

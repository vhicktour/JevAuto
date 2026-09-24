import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoutingMac, type WebSide } from '../src/agent/browser/routing'
import { WEB_PID, WEB_APP, WEB_BUNDLE, type WebWindow } from '../src/agent/browser/web'
import { windowsOf } from '../src/agent/mac/results'
import type { Mac } from '../src/agent/mac/visible'
import type { CuaResult } from '../src/agent/mac/cua'

const ok = (structured: unknown): CuaResult => ({ text: 'ok', imageCount: 0, images: [], structured, isError: false, durationMs: 1 })
const CHROME_PID = 500
const cuaWindows = [
  { window_id: 1, pid: 10, app_name: 'Notes', title: 'Notes', bounds: { x: 0, y: 0, width: 800, height: 600 }, z_index: 5, layer: 0, is_on_screen: true },
  { window_id: 2, pid: CHROME_PID, app_name: 'Google Chrome', title: 'Form', bounds: { x: 100, y: 100, width: 1000, height: 700 }, z_index: 9, layer: 0, is_on_screen: true },
]
const tab: WebWindow = { window_id: 2 ** 30, pid: WEB_PID, app_name: WEB_APP, title: 'Form', url: 'https://example.com/', bounds: { x: 100, y: 180, width: 1000, height: 620 }, is_on_screen: true, layer: 0 }
const hidden: WebWindow = { ...tab, window_id: 2 ** 30 + 1, title: 'Other', is_on_screen: false }

function setup(running = true) {
  const cuaCalls: string[] = []
  const webCalls: string[] = []
  const cua: Mac = {
    call: async (name, args) => {
      cuaCalls.push(name)
      if (name === 'list_windows') return ok({ windows: cuaWindows.filter((w) => args.pid === undefined || w.pid === args.pid) })
      if (name === 'list_apps') return ok({ apps: [{ pid: 10, bundle_id: 'com.apple.Notes', name: 'Notes', running: true }] })
      return ok({ from: 'cua' })
    },
    close: async () => {},
  }
  const web: WebSide = {
    running,
    isWeb: (id: unknown): id is number => typeof id === 'number' && id >= 2 ** 30,
    call: async (name) => (webCalls.push(name), ok({ from: 'web' })),
    windows: async () => [tab, hidden],
    chromePid: () => CHROME_PID,
  }
  return { mac: new RoutingMac(cua, web), cuaCalls, webCalls }
}

test('calls for a tab go to the web driver and never reach Cua', async () => {
  const { mac, cuaCalls, webCalls } = setup()
  assert.deepEqual((await mac.call('click', { window_id: 2 ** 30, x: 1, y: 1 })).structured, { from: 'web' })
  assert.deepEqual((await mac.call('click', { window_id: 1, x: 1, y: 1 })).structured, { from: 'cua' })
  assert.deepEqual([webCalls, cuaCalls], [['click'], ['click']])
})

test('the window list shows tabs in place of the agent Chrome windows, with that window’s place in the stack', async () => {
  const { mac } = setup()
  const windows = windowsOf((await mac.call('list_windows', {})).structured)
  assert.deepEqual(windows.map((w) => w.window_id), [1, 2 ** 30, 2 ** 30 + 1])
  assert.equal(windows.find((w) => w.window_id === 2 ** 30)?.z_index, 9)
  assert.equal(windows.find((w) => w.window_id === 2 ** 30 + 1)?.is_on_screen, false)
  assert.deepEqual(windowsOf((await mac.call('list_windows', { pid: WEB_PID })).structured).map((w) => w.window_id), [2 ** 30, 2 ** 30 + 1])
  assert.deepEqual(windowsOf((await mac.call('list_windows', { pid: 10 })).structured).map((w) => w.window_id), [1])
  const onScreen = windowsOf((await mac.call('list_windows', { on_screen_only: true })).structured)
  assert.ok(!onScreen.some((w) => w.window_id === 2 ** 30 + 1))
})

test('the Web shows up as an app while the browser runs, and nothing changes before it starts', async () => {
  const running = setup()
  const apps = ((await running.mac.call('list_apps', {})).structured as { apps: { name: string; bundle_id: string; pid: number }[] }).apps
  assert.deepEqual(apps.at(-1), { pid: WEB_PID, bundle_id: WEB_BUNDLE, name: WEB_APP, running: true })
  const idle = setup(false)
  assert.deepEqual(windowsOf((await idle.mac.call('list_windows', {})).structured).map((w) => w.window_id), [1, 2])
})

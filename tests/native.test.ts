import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { readDisplays, readFrontmost, readMouse, islandRect, overlayRect, type NativeDisplay } from '../src/shared/native'

const HELPER = resolve('native/build/JevNative')

test('JevNative reports every display with sane geometry', async () => {
  const displays = await readDisplays(HELPER)
  assert.ok(displays.length >= 1)
  for (const d of displays) {
    assert.ok(d.frame.width > 0 && d.frame.height > 0 && d.scale >= 1, JSON.stringify(d))
    if (d.notch) {
      assert.ok(d.notch.width >= 150 && d.notch.width <= 300, `notch width ${d.notch.width}`)
      assert.ok(d.notch.height >= 30 && d.notch.height <= 45, `notch height ${d.notch.height}`)
      assert.equal(d.notch.y, d.frame.y)
    }
  }
})

test('JevNative reports the frontmost app and the mouse state', async () => {
  const front = await readFrontmost(HELPER)
  assert.ok(front.pid > 0)
  const mouse = await readMouse(HELPER)
  assert.ok(Number.isInteger(mouse.pressedButtons) && Number.isInteger(mouse.modifierFlags))
})

const builtIn: NativeDisplay = {
  id: 1, name: 'Built-in', scale: 2,
  frame: { x: 0, y: 0, width: 2056, height: 1329 },
  visibleFrame: { x: 0, y: 39, width: 2056, height: 1290 },
  notch: { x: 918, y: 0, width: 220, height: 38 },
}
const leftLg: NativeDisplay = {
  id: 2, name: 'LG FULL HD', scale: 1,
  frame: { x: -1920, y: 0, width: 1920, height: 1080 },
  visibleFrame: { x: -1920, y: 25, width: 1920, height: 1055 },
  notch: null,
}

test('the island centres on the notch at the very top', () => {
  assert.deepEqual(islandRect(builtIn, { width: 360, height: 44 }), { x: 848, y: 0, width: 360, height: 44 })
})

test('a display without a notch at x = -1920 gets a top-centre pill under the menu bar', () => {
  assert.deepEqual(islandRect(leftLg, { width: 360, height: 44 }), { x: -1140, y: 33, width: 360, height: 44 })
})

test('the overlay covers the whole display frame, negative origin included', () => {
  assert.deepEqual(overlayRect(leftLg), { x: -1920, y: 0, width: 1920, height: 1080 })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { readDisplays, readFrontmost, readMouse, readFocus, islandRect, overlayRect, type NativeDisplay } from '../src/shared/native'

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

test('JevNative reports no focused element for a process without UI', async () => {
  const focus = await readFocus(HELPER, process.pid)
  assert.equal(focus.ok, false)
  assert.equal(focus.secure, false)
})

test('JevNative reads the frontmost app\'s focused element with a frame in top-left points', async () => {
  const front = await readFrontmost(HELPER)
  const focus = await readFocus(HELPER, front.pid)
  if (focus.ok && focus.frame) assert.ok(focus.frame.width >= 0 && focus.frame.height >= 0, JSON.stringify(focus))
  assert.equal(typeof focus.webArea, 'boolean')
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

test('the keyboard hold starts before JevAuto acts and ends when released; a helper that cannot hold is a no-op', async () => {
  const { guardKeys } = await import('../src/shared/native')
  const { mkdtempSync, writeFileSync, chmodSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'jevauto-guard-'))
  // Stands in for JevNative guard-keys (the real one would hold this Mac's keyboard during the test).
  const helper = join(dir, 'helper')
  writeFileSync(helper, `#!/bin/bash\n[ "$1" = guard-keys ] || exit 64\necho '{"ok":true}'\ncat > /dev/null\ntouch ${join(dir, 'released')}\n`)
  chmodSync(helper, 0o755)
  const release = await guardKeys(helper)
  assert.equal(existsSync(join(dir, 'released')), false, 'held until released')
  release()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(existsSync(join(dir, 'released')), true)
  const refused = join(dir, 'refused')
  writeFileSync(refused, `#!/bin/bash\necho '{"ok":false}'\nexit 1\n`)
  chmodSync(refused, 0o755)
  const noop = await guardKeys(refused)
  assert.doesNotThrow(() => noop())
})

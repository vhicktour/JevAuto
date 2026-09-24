import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { parseTargetTitle, pngSize, localPixel, targetTitle, minimizeButton, lastInputAt } from '../src/agent/spikes/spike-a'
import { windowsOf, windowStateOf } from '../src/agent/mac/results'

test('parseTargetTitle reads the fixture state', () => {
  assert.deepEqual(parseTargetTitle('JevAuto Target | clicks=3 | buttons=1 | text=42'), { clicks: 3, buttons: 1, text: 42 })
  assert.equal(parseTargetTitle('Something else'), null)
})

test('pngSize reads width and height from the PNG header', async () => {
  const png = await sharp({ create: { width: 321, height: 123, channels: 3, background: '#000' } }).png().toBuffer()
  assert.deepEqual(pngSize(png.toString('base64')), { width: 321, height: 123 })
  assert.equal(pngSize(Buffer.from('not a png').toString('base64')), null)
})

test('localPixel converts a screen-point element to window-local screenshot pixels', () => {
  const p = localPixel({ x: 300, y: 200, width: 100, height: 40 }, { x: 250, y: 150, width: 900, height: 640 }, 2)
  assert.deepEqual(p, { x: 200, y: 140 })
})

test('targetTitle skips the untitled offscreen windows Electron lists first', () => {
  const windows = windowsOf({ windows: [
    { window_id: 12519, pid: 7, title: '', is_on_screen: false },
    { window_id: 12518, pid: 7, title: '', is_on_screen: false },
    { window_id: 12507, pid: 7, title: 'JevAuto Target | clicks=20 | buttons=0 | text=500', is_on_screen: true },
  ] })
  assert.equal(parseTargetTitle(targetTitle(windows))?.clicks, 20)
  assert.equal(targetTitle(windows.slice(0, 2)), undefined)
})

test('minimizeButton picks the middle traffic light, never close or zoom', () => {
  const { elements } = windowStateOf({ elements: [
    { element_index: 1, role: 'AXButton', depth: 1, actions: ['AXPress'], frame: { x: 586, y: 353, w: 16, h: 16 } },
    { element_index: 2, role: 'AXButton', depth: 1, actions: ['AXPress', 'AXZoomWindow', 'AXShowMenu'], frame: { x: 632, y: 353, w: 16, h: 16 } },
    { element_index: 3, role: 'AXButton', depth: 1, actions: ['AXPress'], frame: { x: 609, y: 353, w: 16, h: 16 } },
    { element_index: 4, role: 'AXButton', depth: 2, label: 'Add one', actions: ['AXPress'], frame: { x: 602, y: 401, w: 120, h: 49 } },
  ] })
  assert.equal(minimizeButton(elements)?.element_index, 3)
  assert.equal(minimizeButton(elements.slice(0, 2)), undefined)
})

test('lastInputAt reads when the fixture last received a keystroke, if it says', () => {
  assert.equal(lastInputAt('JevAuto Target | clicks=0 | buttons=0 | text=12 | last=1790123456789'), 1790123456789)
  assert.equal(lastInputAt('JevAuto Target | clicks=0 | buttons=0 | text=0'), null)
  assert.equal(parseTargetTitle('JevAuto Target | clicks=2 | buttons=0 | text=12 | last=1790123456789')?.text, 12)
})

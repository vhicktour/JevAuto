import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { countMagenta, desktopPixel } from '../src/agent/spikes/spike-b'

test('countMagenta finds exactly the magenta pixels, tolerating P3 shifts', async () => {
  const base = sharp({ create: { width: 100, height: 50, channels: 3, background: '#ffffff' } })
  const square = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 250, g: 20, b: 245 } } }).png().toBuffer()
  const png = await base.composite([{ input: square, left: 5, top: 5 }]).png().toBuffer()
  assert.deepEqual(await countMagenta(png.toString('base64')), { magenta: 100, width: 100, height: 50 })
})

test('desktopPixel turns an element frame in screen points into desktop-capture pixels', () => {
  assert.deepEqual(desktopPixel({ x: 602, y: 401, width: 120, height: 49 }, 2), { x: 1324, y: 851 })
  assert.deepEqual(desktopPixel({ x: 10, y: 20, width: 30, height: 40 }, 1), { x: 25, y: 40 })
})

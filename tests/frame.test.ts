import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import {
  planLetterbox, canvasToCapture, captureToCanvas, normalized1000ToCanvas,
  claudeVisualTokens, CANVAS, makeFrame, canvasToScreenPoints,
} from '../src/agent/frame/frame'

const size = fc.record({ width: fc.integer({ min: 200, max: 6000 }), height: fc.integer({ min: 200, max: 4000 }) })

test('letterbox never upscales and always fits the canvas with the capture aspect', () => {
  fc.assert(fc.property(size, (capture) => {
    const lb = planLetterbox(capture, CANVAS.anthropic)
    assert.ok(lb.scale.x <= 1 && lb.scale.y <= 1)
    assert.ok(lb.content.width <= CANVAS.anthropic.width && lb.content.height <= CANVAS.anthropic.height)
    const aspect = capture.width / capture.height
    assert.ok(Math.abs(lb.content.width / lb.content.height - aspect) < 0.02 * aspect + 0.01)
  }))
})

test('capture → canvas → capture round-trips within one scaled pixel', () => {
  fc.assert(fc.property(size, fc.double({ min: 0, max: 0.999, noNaN: true }), fc.double({ min: 0, max: 0.999, noNaN: true }), (capture, fx, fy) => {
    const lb = planLetterbox(capture, CANVAS.openai)
    const p = { x: fx * capture.width, y: fy * capture.height }
    const back = canvasToCapture(captureToCanvas(p, lb), lb, capture)
    assert.ok(back)
    assert.ok(Math.abs(back.x - p.x) <= 1 / lb.scale.x + 1)
    assert.ok(Math.abs(back.y - p.y) <= 1 / lb.scale.y + 1)
  }))
})

test('a point on the padding maps to null', () => {
  const capture = { width: 1000, height: 1000 }
  const lb = planLetterbox(capture, { width: 1280, height: 800 })
  assert.equal(lb.content.width, 800)
  assert.equal(canvasToCapture({ x: 900, y: 100 }, lb, capture), null)
  assert.equal(canvasToCapture({ x: 100, y: 850 }, lb, capture), null)
})

test('a point in the last column of a rounded-down content width still maps back', () => {
  const capture = { width: 200, height: 1448 }
  const lb = planLetterbox(capture, CANVAS.openai)
  assert.equal(lb.content.width, 110) // 200 × 800/1448 = 110.497, rounded down
  assert.ok(canvasToCapture(captureToCanvas({ x: 199.1, y: 0 }, lb), lb, capture))
})

test('Gemini 0–999 coordinates clamp and scale by 1000', () => {
  assert.deepEqual(normalized1000ToCanvas({ x: 0, y: 0 }, CANVAS.google), { x: 0, y: 0 })
  assert.deepEqual(normalized1000ToCanvas({ x: 500, y: 500 }, CANVAS.google), { x: 720, y: 450 })
  const edge = normalized1000ToCanvas({ x: 1400, y: -3 }, CANVAS.google)
  assert.ok(edge.x < CANVAS.google.width && edge.y === 0)
})

test('Claude canvas stays inside the image limits', () => {
  assert.ok(Math.max(CANVAS.anthropic.width, CANVAS.anthropic.height) <= 2576)
  assert.ok(claudeVisualTokens(CANVAS.anthropic) <= 4784)
})

test('2× built-in window maps canvas points to screen points', () => {
  const frame = makeFrame('window', { width: 2000, height: 1000 }, { x: 100, y: 50, width: 1000, height: 500 }, CANVAS.anthropic)
  assert.equal(frame.pixelsPerPoint, 2)
  const p = canvasToScreenPoints(captureToCanvas({ x: 1000, y: 500 }, frame.letterbox), frame)
  assert.ok(p && Math.abs(p.x - 600) < 1 && Math.abs(p.y - 300) < 1)
})

test('1× window on the display at x = -1920 keeps negative screen x', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1599 }), (x) => {
    const frame = makeFrame('window', { width: 1600, height: 900 }, { x: -1800, y: 100, width: 1600, height: 900 }, CANVAS.openai)
    const p = canvasToScreenPoints(captureToCanvas({ x, y: 10 }, frame.letterbox), frame)
    assert.ok(p && p.x < 0 && Math.abs(p.x - (-1800 + x)) <= 2)
  }))
})

test('1.5× scale is computed from the capture, not assumed', () => {
  const frame = makeFrame('window', { width: 1500, height: 900 }, { x: 0, y: 0, width: 1000, height: 600 }, CANVAS.openai)
  assert.equal(frame.pixelsPerPoint, 1.5)
})

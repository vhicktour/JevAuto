import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { CURSOR, SPEEDS, motionFor, planDrag, planTravel, travelAt } from '../src/renderer/src/cursor/motion'

const point = fc.record({ x: fc.integer({ min: -1920, max: 3976 }), y: fc.integer({ min: 0, max: 1329 }) })
const xy = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })

test('a travel starts at the cursor and ends exactly on the target', () => {
  fc.assert(fc.property(point, point, (from, to) => {
    const tr = planTravel(from, to)
    assert.deepEqual(xy(travelAt(tr, 0).point), xy(from))
    const end = travelAt(tr, tr.durationMs)
    assert.deepEqual(xy(end.point), xy(to))
    assert.equal(end.done, true)
  }))
})

test('the arc bends like a hand, never more than the turn radius off the straight line', () => {
  fc.assert(fc.property(point, point, (from, to) => {
    const { control } = planTravel(from, to)
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    assert.ok(Math.hypot(control.x - mid.x, control.y - mid.y) <= CURSOR.turnRadius + 1e-9)
  }))
})

test('duration follows distance at the peak speed, within the floor and the cap', () => {
  assert.equal(planTravel({ x: 0, y: 0 }, { x: 0, y: 0 }).durationMs, 0)
  assert.equal(planTravel({ x: 0, y: 0 }, { x: 10, y: 0 }).durationMs, CURSOR.minTravelMs)
  assert.equal(planTravel({ x: 0, y: 0 }, { x: 300, y: 0 }).durationMs, 500) // 1.5 × 300 pt ÷ 900 pt/s
  assert.equal(planTravel({ x: 0, y: 0 }, { x: 3000, y: 0 }).durationMs, CURSOR.maxTravelMs)
})

test('below the cap the cursor never moves faster than about the peak speed', () => {
  const tr = planTravel({ x: 100, y: 100 }, { x: 400, y: 300 })
  let fastest = 0
  let prev = travelAt(tr, 0).point
  for (let ms = 4; ms <= tr.durationMs; ms += 4) {
    const p = travelAt(tr, ms).point
    fastest = Math.max(fastest, (Math.hypot(p.x - prev.x, p.y - prev.y) / 4) * 1000)
    prev = p
  }
  assert.ok(fastest <= CURSOR.peakSpeed * 1.15, `peak ${Math.round(fastest)} pt/s`)
})

test('heading points along the path, towards the target', () => {
  const tr = planTravel({ x: 0, y: 0 }, { x: 400, y: 0 })
  const h = travelAt(tr, tr.durationMs / 2).heading
  assert.ok(Math.cos(h) > 0.9, `heading ${h}`)
})

test('a drag is a straight line at the pace of the drag, not an arc', () => {
  const d = planDrag({ x: 10, y: 20 }, { x: 210, y: 120 }, 500)
  assert.equal(d.durationMs, 500)
  assert.deepEqual(d.control, { x: 110, y: 70 })
})

test('speed modes: Instant jumps, Cinematic takes longer than Balanced, Balanced is the default motion', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 400, y: 300 }
  assert.deepEqual(motionFor('balanced'), CURSOR)
  assert.equal(planTravel(from, to, motionFor('instant')).durationMs, 0)
  assert.ok(planTravel(from, to, motionFor('cinematic')).durationMs > planTravel(from, to).durationMs)
  assert.ok(motionFor('cinematic').dwellMs > CURSOR.dwellMs)
})

test('Teach moves at Cinematic pace (it adds the drawn path and step numbers, not a new speed)', () => {
  assert.deepEqual(SPEEDS, ['instant', 'balanced', 'cinematic', 'teach'])
  assert.deepEqual(motionFor('teach'), motionFor('cinematic'))
})

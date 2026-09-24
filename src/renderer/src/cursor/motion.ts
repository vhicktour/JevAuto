export type Point = { x: number; y: number }

/** Cua's cursor motion constants (spec §9), plus a floor and a cap so short hops read and long ones never lag the action. */
export const CURSOR = {
  peakSpeed: 900, // pt/s
  turnRadius: 80, // pt
  pressMs: 120,
  dwellMs: 80,
  minTravelMs: 160,
  maxTravelMs: 650,
} as const

export type Travel = { from: Point; to: Point; control: Point; durationMs: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Ease-in-out sine: its speed peaks at π/2 ≈ 1.57× the average, in the middle of the travel. */
export const easeInOutSine = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2

/** A quadratic arc from `from` to `to`, bent sideways like a hand's path by at most the turn radius. */
export function planTravel(from: Point, to: Point): Travel {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const d = Math.hypot(dx, dy)
  if (d === 0) return { from, to, control: { ...to }, durationMs: 0 }
  const durationMs = Math.round(clamp(((1.5 * d) / CURSOR.peakSpeed) * 1000, CURSOR.minTravelMs, CURSOR.maxTravelMs))
  const bend = Math.min(CURSOR.turnRadius, d * 0.2)
  const side = dx >= 0 ? -1 : 1 // always bow the same way relative to travel, so paths feel consistent
  const control = { x: (from.x + to.x) / 2 + (-dy / d) * bend * side, y: (from.y + to.y) / 2 + (dx / d) * bend * side }
  return { from, to, control, durationMs }
}

/** Where the cursor is `elapsedMs` into a travel, and which way it faces (radians, 0 = +x). */
export function travelAt(tr: Travel, elapsedMs: number): { point: Point; heading: number; done: boolean } {
  const done = tr.durationMs === 0 || elapsedMs >= tr.durationMs
  const t = done ? 1 : easeInOutSine(clamp(elapsedMs / tr.durationMs, 0, 1))
  const u = 1 - t
  const point = done
    ? { ...tr.to }
    : elapsedMs <= 0
      ? { ...tr.from }
      : { x: u * u * tr.from.x + 2 * u * t * tr.control.x + t * t * tr.to.x, y: u * u * tr.from.y + 2 * u * t * tr.control.y + t * t * tr.to.y }
  const vx = 2 * u * (tr.control.x - tr.from.x) + 2 * t * (tr.to.x - tr.control.x)
  const vy = 2 * u * (tr.control.y - tr.from.y) + 2 * t * (tr.to.y - tr.control.y)
  return { point, heading: Math.atan2(vy, vx), done }
}

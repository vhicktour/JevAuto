export type Size = { width: number; height: number }
export type Point = { x: number; y: number }
export type Rect = Point & Size

/**
 * The capture is scaled down (never up) and anchored at the canvas top-left; the rest is padding.
 * `scale` is content ÷ capture per axis: the ratio of the pixels actually sent (whole-pixel content sizes can differ slightly per axis).
 */
export type Letterbox = { canvas: Size; content: Size; scale: { x: number; y: number } }

export type Frame = {
  source: 'window' | 'viewport'
  capture: Size
  letterbox: Letterbox
  originPoints: Point
  pixelsPerPoint: number
}

/** One fixed canvas per provider for a whole run (spec §7). */
export const CANVAS = {
  anthropic: { width: 1280, height: 800 },
  openai: { width: 1280, height: 800 },
  google: { width: 1440, height: 900 },
} as const satisfies Record<string, Size>

function positive(s: Size, name: string) {
  if (!(s.width > 0 && s.height > 0)) throw new Error(`${name} must have positive width and height`)
}

export function planLetterbox(capture: Size, canvas: Size): Letterbox {
  positive(capture, 'capture')
  positive(canvas, 'canvas')
  const fit = Math.min(1, canvas.width / capture.width, canvas.height / capture.height)
  const content = {
    width: Math.max(1, Math.min(canvas.width, Math.round(capture.width * fit))),
    height: Math.max(1, Math.min(canvas.height, Math.round(capture.height * fit))),
  }
  return { canvas, content, scale: { x: content.width / capture.width, y: content.height / capture.height } }
}

export function captureToCanvas(p: Point, lb: Letterbox): Point {
  return { x: p.x * lb.scale.x, y: p.y * lb.scale.y }
}

export function canvasToCapture(p: Point, lb: Letterbox, capture: Size): Point | null {
  if (p.x < 0 || p.y < 0 || p.x >= lb.content.width || p.y >= lb.content.height) return null
  return {
    x: Math.min(capture.width - 1, p.x / lb.scale.x),
    y: Math.min(capture.height - 1, p.y / lb.scale.y),
  }
}

/** Gemini returns ints 0–999 normalised by 1000 (spec §7). */
export function normalized1000ToCanvas(p: Point, canvas: Size): Point {
  const clamp = (v: number) => Math.min(999, Math.max(0, Math.round(v)))
  return { x: (clamp(p.x) / 1000) * canvas.width, y: (clamp(p.y) / 1000) * canvas.height }
}

export function claudeVisualTokens(s: Size): number {
  return Math.ceil(s.width / 28) * Math.ceil(s.height / 28)
}

export function makeFrame(source: Frame['source'], capture: Size, boundsPoints: Rect, canvas: Size): Frame {
  positive(boundsPoints, 'bounds')
  return {
    source,
    capture,
    letterbox: planLetterbox(capture, canvas),
    originPoints: { x: boundsPoints.x, y: boundsPoints.y },
    pixelsPerPoint: capture.width / boundsPoints.width,
  }
}

/** Where a screen point shows on the canvas; null when it falls outside the captured window. */
export function screenPointsToCanvas(p: Point, f: Frame): Point | null {
  const c = { x: (p.x - f.originPoints.x) * f.pixelsPerPoint, y: (p.y - f.originPoints.y) * f.pixelsPerPoint }
  if (c.x < 0 || c.y < 0 || c.x >= f.capture.width || c.y >= f.capture.height) return null
  return captureToCanvas(c, f.letterbox)
}

export function canvasToScreenPoints(p: Point, f: Frame): Point | null {
  const c = canvasToCapture(p, f.letterbox, f.capture)
  if (!c) return null
  return { x: f.originPoints.x + c.x / f.pixelsPerPoint, y: f.originPoints.y + c.y / f.pixelsPerPoint }
}

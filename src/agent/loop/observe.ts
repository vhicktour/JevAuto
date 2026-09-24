import sharp from 'sharp'
import { makeFrame, type Frame, type Rect, type Size } from '../frame/frame'
import { windowStateOf, type ElementInfo } from '../mac/results'
import type { Mac } from '../mac/visible'

/** The one window the model sees and acts in ("the window is the screen", spec §4). */
export type Target = { pid: number; windowId: number; app: string; title?: string; bundleId?: string }

export type Observation = {
  target: Target
  frame: Frame
  /** Base64 PNG, exactly the run's canvas: the capture scaled down and padded with black. */
  image: string
  elements: ElementInfo[]
  snapshotId?: string
  /** Window bounds in screen points when the capture was taken. */
  bounds: Rect
  title?: string
  /** A 160×100 grayscale thumbnail and the AX text (roles, labels, values), for stall detection. */
  thumb: Buffer
  axText: string
  /** The AX walk timed out, so this observation is the screenshot alone: no elements to gate or type into. */
  axMissing?: boolean
}

export class ObserveError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

type WindowState = { window_bounds?: Rect; window_title?: string; code?: string }

export async function observe(mac: Mac, target: Target, canvas: Size, signal?: AbortSignal): Promise<Observation> {
  const args = { pid: target.pid, window_id: target.windowId }
  let r = await mac.call('get_window_state', args, signal)
  let axMissing = false
  // Cua gives up on an AX walk after 20 s (a hung app, a huge tree); the screenshot alone still lets the model work.
  if (r.isError && /timed out/i.test(r.text)) {
    r = await mac.call('get_window_state', { ...args, include_accessibility_tree: false }, signal)
    axMissing = true
  }
  const s = (r.structured ?? {}) as WindowState
  if (r.isError) throw new ObserveError(r.text.slice(0, 300), s.code ?? r.errorCode)
  const shot = r.images[0]
  if (!shot || !s.window_bounds) throw new ObserveError(`${target.app} returned no screenshot of its window.`, 'no_screenshot')
  const png = Buffer.from(shot.dataBase64, 'base64')
  // Cua's pixel coordinates are pixels of this PNG, so its own size is the capture size.
  const meta = await sharp(png).metadata()
  if (!meta.width || !meta.height) throw new ObserveError('The window screenshot could not be read.', 'bad_screenshot')
  const frame = makeFrame('window', { width: meta.width, height: meta.height }, s.window_bounds, canvas)
  const { content } = frame.letterbox
  const [image, thumb] = await Promise.all([
    sharp(png)
      .resize(content.width, content.height, { fit: 'fill' })
      .extend({ right: canvas.width - content.width, bottom: canvas.height - content.height, background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .png()
      .toBuffer(),
    sharp(png).resize(THUMB.width, THUMB.height, { fit: 'fill' }).grayscale().raw().toBuffer(),
  ])
  const state = windowStateOf(r.structured)
  return {
    target: { ...target, ...(s.window_title ? { title: s.window_title } : {}) },
    frame,
    image: image.toString('base64'),
    elements: state.elements,
    snapshotId: state.snapshotId,
    bounds: s.window_bounds,
    title: s.window_title,
    thumb,
    axText: state.elements.map((e) => `${e.role}|${e.label ?? ''}|${typeof e.value === 'string' ? e.value : ''}`).join('\n'),
    ...(axMissing ? { axMissing } : {}),
  }
}

const THUMB = { width: 160, height: 100 }

/**
 * True when nothing visible or readable changed: AX reports the same text, and fewer than four thumbnail pixels moved by
 * more than 24 grey levels. A caret blink stays under that; a line of text turning bold does not.
 */
export function sameView(a: Observation, b: Observation): boolean {
  if (a.axText !== b.axText || a.thumb.length !== b.thumb.length) return false
  let changed = 0
  for (let i = 0; i < a.thumb.length; i++) if (Math.abs(a.thumb[i] - b.thumb[i]) > 24 && ++changed > 3) return false
  return true
}

let blank: { key: string; png: string } | undefined
/** A black canvas for a computer call answered while no window is targeted. */
export async function blankCanvas(canvas: Size): Promise<string> {
  const key = `${canvas.width}x${canvas.height}`
  if (blank?.key !== key)
    blank = { key, png: (await sharp({ create: { ...canvas, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()).toString('base64') }
  return blank.png
}

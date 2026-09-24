import sharp from 'sharp'
import { z } from 'zod'
import type { MacDriver } from '../mac/cua'
import { windowsOf, windowStateOf, findElement, type WindowInfo } from '../mac/results'
import { parseTargetTitle, targetTitle } from './spike-a'
import type { Rect, Point } from '../frame/frame'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Dominance thresholds, because captures can arrive colour-managed (P3), not exact sRGB. */
export async function countMagenta(pngBase64: string) {
  const { data, info } = await sharp(Buffer.from(pngBase64, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let magenta = 0
  for (let i = 0; i < data.length; i += 3) if (data[i] > 200 && data[i + 2] > 200 && data[i + 1] < 60) magenta++
  return { magenta, width: info.width, height: info.height }
}

/** A desktop-scope click takes pixels of the desktop capture: the element's centre in points times the display scale. */
export function desktopPixel(frame: Rect, scale: number): Point {
  return { x: Math.round((frame.x + frame.width / 2) * scale), y: Math.round((frame.y + frame.height / 2) * scale) }
}

export const SpikeBParams = z.object({
  mode: z.enum(['window', 'desktop', 'click-through']),
  centre: z.object({ x: z.number(), y: z.number() }).optional(),
})

const onCurrentSpace = (w: WindowInfo | undefined) => (w as { on_current_space?: boolean | null } | undefined)?.on_current_space ?? null

export async function spikeBCapture(mac: MacDriver, params: z.infer<typeof SpikeBParams>) {
  // Off-screen too: a full-screen fixture lives on its own Space.
  const fixture = async () =>
    windowsOf((await mac.call('list_windows', { on_screen_only: false })).structured).find((w) => (w.title ?? '').startsWith('JevAuto Target'))
  const target = await fixture()
  if (params.mode === 'desktop') {
    const shot = await mac.call('get_desktop_state', {})
    const counted = shot.images[0] ? await countMagenta(shot.images[0].dataBase64) : { magenta: -1 }
    return { ...counted, fixtureOnCurrentSpace: onCurrentSpace(target) }
  }
  if (!target) throw new Error('Start `pnpm fixture:electron` first.')
  if (params.mode === 'window') {
    // Put the fixture right under the overlay's magenta square, then capture only that window.
    if (params.centre)
      await mac.call('set_window_frame', { pid: target.pid, window_id: target.window_id, x: params.centre.x - 450, y: params.centre.y - 320, width: 900, height: 640 })
    const shot = await mac.call('get_window_state', { pid: target.pid, window_id: target.window_id, include_screenshot: true, include_accessibility_tree: false })
    return shot.images[0] ? await countMagenta(shot.images[0].dataBase64) : { magenta: -1 }
  }
  // click-through: a real, desktop-scope click through the overlay onto the fixture's button. The fixture comes to the
  // front first so that only the click-through overlay is above the button.
  await mac.call('bring_to_front', { pid: target.pid, window_id: target.window_id })
  await sleep(500)
  const s = await mac.call('get_window_state', { pid: target.pid, window_id: target.window_id, include_accessibility_tree: true, include_screenshot: false })
  const add = findElement(windowStateOf(s.structured).elements, 'AXButton', 'Add one')
  const readClicks = async () => parseTargetTitle(targetTitle(windowsOf((await mac.call('list_windows', { pid: target.pid })).structured)))?.clicks ?? 0
  const before = await readClicks()
  const scale = z.object({ scale_factor: z.number() }).passthrough().parse((await mac.call('get_screen_size', {})).structured).scale_factor
  const clicked = add?.frame ? await mac.call('click', { ...desktopPixel(add.frame, scale), scope: 'desktop' }) : undefined
  await sleep(400) // the page handles the click asynchronously
  return { clicksBefore: before, clicksAfter: await readClicks(), clickError: clicked?.isError ? clicked.text.slice(0, 200) : clicked ? null : 'Add one not found' }
}

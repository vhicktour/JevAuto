import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const run = promisify(execFile)
const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
export type Rect = z.infer<typeof RectSchema>

export const NativeDisplay = z.object({
  id: z.number().int(),
  name: z.string(),
  frame: RectSchema,
  visibleFrame: RectSchema,
  scale: z.number().positive(),
  notch: RectSchema.nullable().optional(),
})
export type NativeDisplay = z.infer<typeof NativeDisplay>

const Frontmost = z.object({ bundleId: z.string().nullable(), pid: z.number().int(), name: z.string().nullable() })
const Mouse = z.object({ pressedButtons: z.number().int(), modifierFlags: z.number().int() })

async function call(helper: string, command: 'displays' | 'frontmost' | 'mouse'): Promise<unknown> {
  const { stdout } = await run(helper, [command], { timeout: 5000 })
  return JSON.parse(stdout)
}

export async function readDisplays(helper: string): Promise<NativeDisplay[]> {
  return z.array(NativeDisplay).min(1).parse(await call(helper, 'displays'))
}
export async function readFrontmost(helper: string) {
  return Frontmost.parse(await call(helper, 'frontmost'))
}
export async function readMouse(helper: string) {
  return Mouse.parse(await call(helper, 'mouse'))
}

/** Centred on the notch at the top edge; displays without a notch get a pill 8 pt under the menu bar. */
export function islandRect(d: NativeDisplay, size: { width: number; height: number }): Rect {
  const centreX = d.notch ? d.notch.x + d.notch.width / 2 : d.frame.x + d.frame.width / 2
  const y = d.notch ? d.frame.y : d.visibleFrame.y + 8
  return { x: Math.round(centreX - size.width / 2), y: Math.round(y), width: size.width, height: size.height }
}

export function overlayRect(d: NativeDisplay): Rect {
  return { ...d.frame }
}

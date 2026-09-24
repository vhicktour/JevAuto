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
export const Focus = z.object({
  ok: z.boolean(),
  error: z.string().nullish(),
  role: z.string().nullish(),
  subrole: z.string().nullish(),
  frame: RectSchema.nullish(),
  windowFrame: RectSchema.nullish(),
  /** Inside web content (an AXWebArea ancestor): an AX insert may never reach the page. */
  webArea: z.boolean(),
  /** A password field (AXSecureTextField): JevAuto never types into one. */
  secure: z.boolean(),
})
export type Focus = z.infer<typeof Focus>

async function call(helper: string, ...args: ['displays' | 'frontmost' | 'mouse'] | ['ax-focus', string]): Promise<unknown> {
  const { stdout } = await run(helper, args, { timeout: 5000 })
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
/** Where the keystrokes for `pid` would go. Cua has no focus query, so the helper asks AX directly. */
export async function readFocus(helper: string, pid: number): Promise<Focus> {
  return Focus.parse(await call(helper, 'ax-focus', String(pid)))
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

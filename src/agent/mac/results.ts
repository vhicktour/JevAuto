import { z } from 'zod'

const Bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
/** Cua 0.28 reports element frames as `{ x, y, w, h }` in screen points; callers get `Bounds`. */
const ElementFrame = z
  .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  .transform(({ x, y, w, h }) => ({ x, y, width: w, height: h }))
export const WindowInfo = z
  .object({
    window_id: z.number(),
    pid: z.number(),
    app_name: z.string().optional(),
    title: z.string().optional(),
    bounds: Bounds.optional(),
    z_index: z.number().optional(),
    /** 0 for normal windows; floating panels, menus and overlays sit above it. */
    layer: z.number().optional(),
    is_on_screen: z.boolean().optional(),
    on_current_space: z.boolean().nullable().optional(),
  })
  .passthrough()
export type WindowInfo = z.infer<typeof WindowInfo>

export const ElementInfo = z
  .object({
    element_index: z.number(),
    role: z.string(),
    label: z.string().nullable().optional(),
    value: z.unknown().optional(),
    actions: z.array(z.string()).optional(),
    frame: ElementFrame.optional(),
  })
  .passthrough()
export type ElementInfo = z.infer<typeof ElementInfo>

export function windowsOf(structured: unknown): WindowInfo[] {
  const parsed = z.object({ windows: z.array(WindowInfo) }).passthrough().safeParse(structured)
  return parsed.success ? parsed.data.windows : []
}

/** One element Cua can't describe (no index, odd frame) is skipped instead of hiding the whole tree. */
export function windowStateOf(structured: unknown): { snapshotId?: string; elements: ElementInfo[] } {
  const parsed = z.object({ snapshot_id: z.string().optional(), elements: z.array(z.unknown()) }).passthrough().safeParse(structured)
  if (!parsed.success) return { elements: [] }
  const elements = parsed.data.elements.flatMap((e) => {
    const element = ElementInfo.safeParse(e)
    return element.success ? [element.data] : []
  })
  return { snapshotId: parsed.data.snapshot_id, elements }
}

export function findElement(elements: ElementInfo[], role: string, labelIncludes?: string): ElementInfo | undefined {
  return elements.find(
    (e) => e.role === role && (labelIncludes === undefined || (e.label ?? '').toLowerCase().includes(labelIncludes.toLowerCase())),
  )
}

export function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

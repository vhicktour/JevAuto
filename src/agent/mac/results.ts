import { z } from 'zod'

const Bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
export const WindowInfo = z
  .object({
    window_id: z.number(),
    pid: z.number(),
    app_name: z.string().optional(),
    title: z.string().optional(),
    bounds: Bounds.optional(),
    z_index: z.number().optional(),
    is_on_screen: z.boolean().optional(),
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
    frame: Bounds.optional(),
  })
  .passthrough()
export type ElementInfo = z.infer<typeof ElementInfo>

export function windowsOf(structured: unknown): WindowInfo[] {
  const parsed = z.object({ windows: z.array(WindowInfo) }).passthrough().safeParse(structured)
  return parsed.success ? parsed.data.windows : []
}

export function windowStateOf(structured: unknown): { snapshotId?: string; elements: ElementInfo[] } {
  const parsed = z.object({ snapshot_id: z.string().optional(), elements: z.array(ElementInfo) }).passthrough().safeParse(structured)
  return parsed.success ? { snapshotId: parsed.data.snapshot_id, elements: parsed.data.elements } : { elements: [] }
}

export function findElement(elements: ElementInfo[], role: string, labelIncludes?: string): ElementInfo | undefined {
  return elements.find(
    (e) => e.role === role && (labelIncludes === undefined || (e.label ?? '').toLowerCase().includes(labelIncludes.toLowerCase())),
  )
}

export function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

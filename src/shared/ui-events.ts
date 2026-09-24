import { z } from 'zod'

/** Screen points, top-left origin (Electron's coordinate space). */
const Point = z.object({ x: z.number(), y: z.number() })
const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

/** What the agent is about to do, emitted just before the driver call so the cursor can travel while it runs (spec §9). */
export const UiAct = z.object({
  id: z.string(),
  verb: z.enum(['click', 'type', 'drag', 'key', 'set', 'menu', 'launch', 'scroll', 'other']),
  label: z.string().optional(),
  app: z.string().optional(),
  point: Point.optional(),
  rect: Rect.optional(),
  to: Point.optional(),
  /** False when the target is covered, minimised or off-Space: no cursor over your windows (occlusion rule). */
  visible: z.boolean(),
})
export type UiAct = z.infer<typeof UiAct>

export const UiDone = z.object({ id: z.string(), ok: z.boolean(), ms: z.number() })
export type UiDone = z.infer<typeof UiDone>

export const UiStatus = z.object({
  state: z.enum(['idle', 'working', 'needs-you', 'error', 'done', 'stopped']),
  title: z.string(),
  detail: z.string().optional(),
  step: z.object({ n: z.number().int().positive(), of: z.number().int().positive() }).optional(),
})
export type UiStatus = z.infer<typeof UiStatus>

/** Every event a surface can receive, sent on the one `jevauto:event` channel. */
export const UiEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status-line'), line: z.string() }),
  z.object({ type: z.literal('act'), act: UiAct }),
  z.object({ type: z.literal('done'), done: UiDone }),
  z.object({ type: z.literal('status'), status: UiStatus }),
  z.object({ type: z.literal('permissions'), accessibility: z.boolean(), screenRecording: z.boolean() }),
])
export type UiEvent = z.infer<typeof UiEvent>

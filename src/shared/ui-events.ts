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
  /** Clicks: 2 for a double-click. */
  count: z.number().int().min(1).max(3).optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  /** Modifier keys held through a click or drag, in Cua's names (cmd, shift, option, ctrl). */
  held: z.array(z.string()).optional(),
  /** What is being typed, for the typing animation. */
  text: z.string().max(200).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
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

/** A step waiting for your OK (spec §8). `offersRun` adds "for this run" (foreground delivery only). */
export const UiApproval = z.object({
  id: z.string(),
  kind: z.enum(['action', 'foreground', 'budget']),
  title: z.string(),
  reason: z.string(),
  app: z.string().optional(),
  offersRun: z.boolean(),
})
export type UiApproval = z.infer<typeof UiApproval>

export const UiQuestion = z.object({ id: z.string(), question: z.string() })
export type UiQuestion = z.infer<typeof UiQuestion>

/** Every event a surface can receive, sent on the one `jevauto:event` channel. */
export const UiEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status-line'), line: z.string() }),
  z.object({ type: z.literal('act'), act: UiAct }),
  z.object({ type: z.literal('done'), done: UiDone }),
  z.object({ type: z.literal('status'), status: UiStatus }),
  z.object({ type: z.literal('permissions'), accessibility: z.boolean(), screenRecording: z.boolean() }),
  z.object({ type: z.literal('approval'), approval: UiApproval }),
  z.object({ type: z.literal('approval-closed'), id: z.string() }),
  z.object({ type: z.literal('question'), question: UiQuestion }),
  z.object({ type: z.literal('question-closed'), id: z.string() }),
  /** Watch mode (each target comes to the front so the cursor can be seen working) and the model tasks run on. */
  z.object({ type: z.literal('settings'), watch: z.boolean(), model: z.string() }),
])
export type UiEvent = z.infer<typeof UiEvent>

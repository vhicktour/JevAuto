import { z } from 'zod'

/**
 * The tools Claude Code gets over MCP to drive JevAuto (spec §12, "after v1: MCP exposure"). Claude is the brain: it
 * sees each window through `look` and acts with coordinates in pixels of the latest screenshot. JevAuto's own loop
 * runs every call, so its gate, approvals, cursor, island and Stop apply as they do to JevAuto's own models.
 */
const Point = z.object({ x: z.number().describe('Pixels from the left of the latest screenshot.'), y: z.number().describe('Pixels from its top.') }).strict()
const x = z.number().describe('Pixels from the left of the latest screenshot.')
const y = z.number().describe('Pixels from the top of the latest screenshot.')
const screenshot = z.boolean().default(true).describe('Return a fresh screenshot after the action (default true).')
const click = {
  x,
  y,
  button: z.enum(['left', 'right', 'middle']).default('left'),
  count: z.number().int().min(1).max(3).default(1).describe('2 for a double-click, 3 for a triple-click.'),
  modifiers: z.array(z.enum(['cmd', 'shift', 'option', 'ctrl'])).max(4).default([]).describe('Keys held during the click.'),
}
const text = z.string().min(1).max(10_000)
const keys = z.array(z.string().min(1).max(20)).min(1).max(5)
const scroll = { x, y, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(25).default(3).describe('Wheel notches.') }
const seconds = z.number().int().min(1).max(10).default(1)
/** One step of `do`: the acting tools without their own screenshot. */
const Step = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('click'), ...click }).strict(),
  z.object({ tool: z.literal('type'), text }).strict(),
  z.object({ tool: z.literal('keys'), keys }).strict(),
  z.object({ tool: z.literal('scroll'), ...scroll }).strict(),
  z.object({ tool: z.literal('drag'), from: Point, to: Point }).strict(),
  z.object({ tool: z.literal('wait'), seconds }).strict(),
])

export const DRIVE_TOOLS = {
  look: {
    description:
      'See a window. Returns a screenshot (every x/y you pass later is in pixels of the latest screenshot) and the labelled controls with their centre points. Pass window to switch to another window from `windows`; without it you see the current one.',
    input: z.object({ window: z.number().int().optional().describe('A window id from `windows`.') }).strict(),
  },
  windows: {
    description: 'List the windows and web pages JevAuto can work in, frontmost first, with their window ids. Web pages show as the app "Web".',
    input: z.object({}).strict(),
  },
  open_app: {
    description: 'Open a Mac app (or find it if it is running) and make its window the one you see and act in.',
    input: z.object({ name: z.string().trim().min(1).max(100).describe('For example "Notes" or "TextEdit".') }).strict(),
  },
  open_url: {
    description: 'Open a website in JevAuto’s own browser (the current page if you are looking at one, else a new tab, which becomes the window you see).',
    input: z.object({ url: z.string().trim().min(1).max(2000).describe('For example "example.com/tickets".') }).strict(),
  },
  click: {
    description: 'Click in the window you last looked at.',
    input: z.object({ ...click, screenshot }).strict(),
  },
  type: {
    description: 'Type text into the focused field of the window you last looked at. Click the field first if it is not focused.',
    input: z.object({ text, screenshot }).strict(),
  },
  keys: {
    description: 'Press one key, with optional modifiers, in the window you last looked at: ["cmd", "b"], ["return"], ["shift", "tab"], ["escape"].',
    input: z.object({ keys, screenshot }).strict(),
  },
  scroll: {
    description: 'Scroll at a point of the window you last looked at.',
    input: z.object({ ...scroll, screenshot }).strict(),
  },
  drag: {
    description: 'Press at one point, move to another and release, in the window you last looked at.',
    input: z.object({ from: Point, to: Point, screenshot }).strict(),
  },
  wait: {
    description: 'Wait for the app or page to catch up, then see the window again.',
    input: z.object({ seconds, screenshot }).strict(),
  },
  do: {
    description:
      'Run several steps in a row in the window you last looked at (click, type, keys, scroll, drag, wait), then get one screenshot. Much faster than one call per step. A step that fails stops the rest, and the result says what did not run.',
    input: z.object({ steps: z.array(Step).min(1).max(25), screenshot }).strict(),
  },
  learn: {
    description:
      'Save one short tip about how an app or site works after you got past a problem (what finally worked), so later sessions go straight to it. Tips show up when that app is looked at again. Describe the app, never the user or the task.',
    input: z
      .object({
        app: z.string().trim().min(1).max(100).describe('The app name, or the site for a web page (for example "linkedin.com").'),
        tip: z.string().trim().min(1).max(300),
      })
      .strict(),
  },
} as const

export type DriveTool = keyof typeof DRIVE_TOOLS
export type DriveCall = { [K in DriveTool]: z.infer<(typeof DRIVE_TOOLS)[K]['input']> & { tool: K } }[DriveTool]

/** Validates one call at a trust boundary (the MCP socket in main, the IPC into the agent). */
export function parseDriveCall(raw: unknown): { ok: true; call: DriveCall } | { ok: false; error: string } {
  const { tool, ...args } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (typeof tool !== 'string' || !Object.hasOwn(DRIVE_TOOLS, tool)) return { ok: false, error: `There is no JevAuto tool called ${JSON.stringify(tool)}.` }
  const parsed = DRIVE_TOOLS[tool as DriveTool].input.safeParse(args)
  if (!parsed.success) return { ok: false, error: `Invalid ${tool} arguments: ${z.prettifyError(parsed.error)}` }
  return { ok: true, call: { tool, ...parsed.data } as DriveCall }
}

/** What a call returns to Claude: text (the target, the result, notes, controls) and the screenshot when asked for. */
export type DriveResult = { ok: boolean; text: string; image?: string }

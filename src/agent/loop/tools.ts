import { z } from 'zod'

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> }

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

/** The custom tools every provider gets next to its computer tool (spec §4). Declared once per run. */
export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'list_windows',
    description: 'List the windows you can work in, frontmost first: window_id, app and title.',
    parameters: object({}),
  },
  {
    name: 'open_app',
    description: 'Open an app in the background, or find it if it is already running, and make its window the target.',
    parameters: object({ name: { type: 'string', description: 'The app name, for example "Notes" or "TextEdit".' } }),
  },
  {
    name: 'switch_target',
    description: 'Make another window the target. Use a window_id from list_windows.',
    parameters: object({ window_id: { type: 'integer' } }),
  },
  {
    name: 'ask_user',
    description: 'Ask the user something only they can answer, such as a choice or a missing detail. Never ask for a password.',
    parameters: object({ question: { type: 'string' } }),
  },
  {
    name: 'done',
    description: 'Finish. Call this once, when the task is complete or cannot be completed.',
    parameters: object({
      status: { type: 'string', enum: ['success', 'failure', 'blocked'] },
      summary: { type: 'string', description: 'One sentence for the user: what you did, or what stopped you.' },
    }),
  },
]

export const ToolInput = {
  list_windows: z.object({}).strict(),
  open_app: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
  switch_target: z.object({ window_id: z.number().int() }).strict(),
  ask_user: z.object({ question: z.string().trim().min(1).max(1000) }).strict(),
  done: z.object({ status: z.enum(['success', 'failure', 'blocked']), summary: z.string().max(2000) }).strict(),
} as const
export type ToolName = keyof typeof ToolInput

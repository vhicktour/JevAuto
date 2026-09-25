import { emptyTurn, type IrAction, type ParsedTurn } from '../ir'

type Step = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; content?: unknown }

/** Gemini's desktop computer-use functions (Interactions API); any other function call is one of our tools. */
export const GEMINI_ACTIONS = new Set(['click', 'double_click', 'triple_click', 'right_click', 'middle_click', 'type', 'scroll', 'drag_and_drop', 'press_key', 'hotkey', 'wait', 'navigate', 'take_screenshot', 'key_down', 'key_up', 'mouse_down', 'mouse_up', 'hover', 'move'])

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Text parts of a model_output step. */
function textOf(step: Step): string {
  if (!Array.isArray(step.content)) return ''
  return step.content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
}

function toIr(name: string, a: Record<string, unknown>, callId: string): IrAction[] {
  const other: IrAction[] = [{ kind: 'other', callId, name, input: a }]
  const at = num(a.x) && num(a.y) ? { x: a.x, y: a.y, space: 'normalized1000' as const } : undefined
  switch (name) {
    case 'click':
    case 'double_click':
    case 'triple_click':
    case 'right_click':
    case 'middle_click':
      if (!at) return other
      return [{ kind: 'click', callId, ...at, button: name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left', ...(name === 'double_click' ? { count: 2 } : name === 'triple_click' ? { count: 3 } : {}) }]
    case 'type':
      if (typeof a.text !== 'string') return other
      return [{ kind: 'type', callId, text: a.text }, ...(a.press_enter === true ? [{ kind: 'keys' as const, callId, keys: ['ENTER'] }] : [])]
    case 'scroll': {
      const m = num(a.magnitude_in_pixels) ? a.magnitude_in_pixels : 400
      const d = String(a.direction)
      if (!['up', 'down', 'left', 'right'].includes(d)) return other
      return [{ kind: 'scroll', callId, ...(at ?? { x: 500, y: 500, space: 'normalized1000' as const }), dx: d === 'left' ? -m : d === 'right' ? m : 0, dy: d === 'up' ? -m : d === 'down' ? m : 0 }]
    }
    case 'drag_and_drop':
      if (![a.start_x, a.start_y, a.end_x, a.end_y].every(num)) return other
      return [{ kind: 'drag', callId, path: [{ x: a.start_x as number, y: a.start_y as number }, { x: a.end_x as number, y: a.end_y as number }], space: 'normalized1000' }]
    case 'press_key':
      return typeof a.key === 'string' ? [{ kind: 'keys', callId, keys: [a.key] }] : other
    case 'hotkey':
      return Array.isArray(a.keys) && a.keys.every((k) => typeof k === 'string') ? [{ kind: 'keys', callId, keys: a.keys as string[] }] : other
    case 'wait':
      return [{ kind: 'wait', callId }]
    case 'navigate':
      return typeof a.url === 'string' ? [{ kind: 'tool', callId, name: 'open_url', input: { url: a.url } }] : other
    case 'take_screenshot':
      return [{ kind: 'screenshot', callId }]
    default:
      return other
  }
}

export function parseGoogle(interaction: { steps?: Step[] }): ParsedTurn {
  const turn = emptyTurn()
  for (const step of interaction.steps ?? []) {
    if (step.type === 'model_output') {
      const t = textOf(step)
      if (t) turn.text.push(t)
    }
    if (step.type !== 'function_call' || !step.id || !step.name) continue
    const { intent, safety_decision: safety, ...args } = step.arguments ?? {}
    if (typeof intent === 'string') turn.text.push(intent) // Gemini narrates every call through `intent`
    if ((safety as { decision?: string } | undefined)?.decision === 'require_confirmation') turn.safety.push({ provider: 'google', callId: step.id, detail: safety })
    if (GEMINI_ACTIONS.has(step.name)) turn.actions.push(...toIr(step.name, args, step.id))
    else turn.actions.push({ kind: 'tool', callId: step.id, name: step.name, input: args })
  }
  return turn
}

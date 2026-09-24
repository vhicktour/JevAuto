import { emptyTurn, type IrAction, type IrPoint, type ParsedTurn } from '../ir'

type Action = { type: string; [key: string]: unknown }
type Item = {
  type: string
  call_id?: string
  name?: string
  arguments?: string
  action?: Action
  actions?: Action[]
  pending_safety_checks?: unknown[]
  content?: Array<{ type: string; text?: string; refusal?: string }>
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const heldKeys = (v: unknown) => (Array.isArray(v) && v.length && v.every((k) => typeof k === 'string') ? { keys: v as string[] } : {})
const BUTTONS: Record<string, 'left' | 'right' | 'middle'> = { left: 'left', right: 'right', wheel: 'middle' }

function toIr(a: Action, callId: string): IrAction {
  const other: IrAction = { kind: 'other', callId, name: a.type, input: a }
  switch (a.type) {
    case 'click': {
      const button = BUTTONS[String(a.button ?? 'left')]
      return button && num(a.x) && num(a.y) ? { kind: 'click', callId, x: a.x, y: a.y, space: 'pixels', button, ...heldKeys(a.keys) } : other
    }
    case 'double_click':
      return num(a.x) && num(a.y) ? { kind: 'click', callId, x: a.x, y: a.y, space: 'pixels', button: 'left', count: 2, ...heldKeys(a.keys) } : other
    case 'drag': {
      const path = Array.isArray(a.path) ? (a.path as IrPoint[]).filter((p) => num(p?.x) && num(p?.y)) : []
      return path.length >= 2 && path.length === (a.path as unknown[]).length ? { kind: 'drag', callId, path, space: 'pixels', ...heldKeys(a.keys) } : other
    }
    case 'keypress':
      return Array.isArray(a.keys) && a.keys.every((k) => typeof k === 'string') ? { kind: 'keys', callId, keys: a.keys as string[] } : other
    case 'move':
      return num(a.x) && num(a.y) ? { kind: 'move', callId, x: a.x, y: a.y, space: 'pixels' } : other
    case 'scroll':
      return num(a.x) && num(a.y) && num(a.scroll_x) && num(a.scroll_y)
        ? { kind: 'scroll', callId, x: a.x, y: a.y, space: 'pixels', dx: a.scroll_x, dy: a.scroll_y, ...heldKeys(a.keys) }
        : other
    case 'type':
      return typeof a.text === 'string' ? { kind: 'type', callId, text: a.text } : other
    case 'wait':
      return { kind: 'wait', callId }
    case 'screenshot':
      return { kind: 'screenshot', callId }
    default:
      return other
  }
}

function jsonOrNull(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '')
  } catch {
    return null
  }
}

export function parseOpenAI(response: { output: Item[] }): ParsedTurn {
  const turn = emptyTurn()
  for (const item of response.output) {
    if (item.type === 'message')
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) turn.text.push(c.text)
        if (c.type === 'refusal') turn.refusal = true
      }
    if (item.type === 'function_call' && item.call_id && item.name)
      turn.actions.push({ kind: 'tool', callId: item.call_id, name: item.name, input: jsonOrNull(item.arguments) })
    if (item.type !== 'computer_call' || !item.call_id) continue
    if (item.pending_safety_checks?.length) turn.safety.push({ provider: 'openai', callId: item.call_id, detail: item.pending_safety_checks })
    for (const a of item.actions ?? (item.action ? [item.action] : [])) turn.actions.push(toIr(a, item.call_id))
  }
  return turn
}

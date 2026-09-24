import { emptyTurn, type IrAction, type IrPoint, type ParsedTurn } from '../ir'

type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; toolset_name?: string; text?: string; thinking?: string }

const pair = (v: unknown): IrPoint | undefined =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: v[0] as number, y: v[1] as number } : undefined
/** Modifier keys on a click, drag or scroll: "shift", "ctrl+shift", "super" (⌘). */
const held = (text: unknown) => (typeof text === 'string' && text.trim() ? { keys: text.toLowerCase().split('+').map((k) => k.trim()).filter(Boolean) } : {})
const CLICKS: Record<string, { button: 'left' | 'right' | 'middle'; count?: number }> = {
  left_click: { button: 'left' },
  double_click: { button: 'left', count: 2 },
  triple_click: { button: 'left', count: 3 },
  right_click: { button: 'right' },
  middle_click: { button: 'middle' },
}

/** One member of `computer_toolset_20260801`. The action is the block's name; coordinates are screenshot pixels. */
function member(name: string, input: Record<string, unknown>, callId: string): IrAction[] {
  const other: IrAction[] = [{ kind: 'other', callId, name, input }]
  const at = pair(input.coordinate)
  if (CLICKS[name]) return at ? [{ kind: 'click', callId, ...at, space: 'pixels', ...CLICKS[name], ...held(input.text) }] : other
  switch (name) {
    case 'left_click_drag': {
      const from = pair(input.start_coordinate)
      return from && at ? [{ kind: 'drag', callId, path: [from, at], space: 'pixels', ...held(input.text) }] : other
    }
    case 'scroll': {
      const d = String(input.scroll_direction)
      const n = typeof input.scroll_amount === 'number' ? input.scroll_amount : 3
      if (!at || !['up', 'down', 'left', 'right'].includes(d)) return other
      return [{ kind: 'scroll', callId, ...at, space: 'pixels', dx: d === 'left' ? -1 : d === 'right' ? 1 : 0, dy: d === 'up' ? -1 : d === 'down' ? 1 : 0, notches: n, ...held(input.text) }]
    }
    case 'type':
      return typeof input.text === 'string' ? [{ kind: 'type', callId, text: input.text }] : other
    case 'key': {
      if (typeof input.text !== 'string') return other
      const keys = input.text.split('+').map((k) => k.trim()).filter(Boolean)
      const repeat = Math.min(20, Math.max(1, typeof input.repeat === 'number' ? Math.round(input.repeat) : 1))
      return Array.from({ length: repeat }, () => ({ kind: 'keys' as const, callId, keys }))
    }
    case 'wait':
      return [{ kind: 'wait', callId }]
    case 'screenshot':
      return [{ kind: 'screenshot', callId }]
    default:
      return other
  }
}

export function parseAnthropic(message: { content: readonly unknown[]; stop_reason?: string | null }): ParsedTurn {
  const turn = emptyTurn()
  turn.refusal = message.stop_reason === 'refusal'
  for (const block of message.content as Block[]) {
    if (block.type === 'text' && block.text) turn.text.push(block.text)
    // With thinking.display "updates", Opus 5.5 writes its between-step notes here (spec §7 narration).
    if (block.type === 'thinking' && block.thinking) turn.text.push(block.thinking)
    if (block.type !== 'tool_use' || !block.id || !block.name) continue
    if (block.toolset_name === 'computer') turn.actions.push(...member(block.name, block.input ?? {}, block.id))
    else turn.actions.push({ kind: 'tool', callId: block.id, name: block.name, input: block.input ?? {} })
  }
  return turn
}

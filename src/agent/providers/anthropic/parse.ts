import { emptyTurn, type ParsedTurn } from '../ir'

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string; toolset_name?: string | null }
const BUTTONS: Record<string, 'left' | 'right' | 'middle'> = { left_click: 'left', right_click: 'right', middle_click: 'middle' }

export function parseAnthropic(message: { stop_reason: string | null; content: Block[] }): ParsedTurn {
  const turn = emptyTurn()
  turn.refusal = message.stop_reason === 'refusal'
  for (const block of message.content) {
    if (block.type === 'text' && block.text) turn.text.push(block.text)
    if (block.type !== 'tool_use' || !block.id || !block.name) continue
    const input = (block.input ?? {}) as { coordinate?: [number, number] }
    const computer = block.toolset_name === 'computer'
    if (computer && BUTTONS[block.name] && Array.isArray(input.coordinate))
      turn.actions.push({ kind: 'click', callId: block.id, x: input.coordinate[0], y: input.coordinate[1], space: 'pixels', button: BUTTONS[block.name] })
    else if (computer && block.name === 'screenshot') turn.actions.push({ kind: 'screenshot', callId: block.id })
    else turn.actions.push({ kind: 'other', callId: block.id, name: block.name, input: block.input })
  }
  return turn
}

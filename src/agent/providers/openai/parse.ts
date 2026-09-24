import { emptyTurn, type ParsedTurn } from '../ir'

type Action = { type: string; x?: number; y?: number; button?: string; [key: string]: unknown }
type Item = {
  type: string
  call_id?: string
  action?: Action
  actions?: Action[]
  pending_safety_checks?: unknown[]
  content?: Array<{ type: string; text?: string; refusal?: string }>
}

export function parseOpenAI(response: { output: Item[] }): ParsedTurn {
  const turn = emptyTurn()
  for (const item of response.output) {
    if (item.type === 'message')
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) turn.text.push(c.text)
        if (c.type === 'refusal') turn.refusal = true
      }
    if (item.type !== 'computer_call' || !item.call_id) continue
    if (item.pending_safety_checks?.length) turn.safety.push({ provider: 'openai', callId: item.call_id, detail: item.pending_safety_checks })
    for (const a of item.actions ?? (item.action ? [item.action] : [])) {
      if (a.type === 'click' && typeof a.x === 'number' && typeof a.y === 'number')
        turn.actions.push({ kind: 'click', callId: item.call_id, x: a.x, y: a.y, space: 'pixels', button: a.button === 'right' ? 'right' : a.button === 'wheel' ? 'middle' : 'left' })
      else if (a.type === 'screenshot') turn.actions.push({ kind: 'screenshot', callId: item.call_id })
      else turn.actions.push({ kind: 'other', callId: item.call_id, name: a.type, input: a })
    }
  }
  return turn
}

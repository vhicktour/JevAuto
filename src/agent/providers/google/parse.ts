import { emptyTurn, type ParsedTurn } from '../ir'

type Step = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; content?: unknown }
const BUTTONS: Record<string, 'left' | 'right' | 'middle'> = { click: 'left', right_click: 'right', middle_click: 'middle' }

/** Text parts of a model_output step. */
function textOf(step: Step): string {
  if (!Array.isArray(step.content)) return ''
  return step.content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
}

export function parseGoogle(interaction: { steps?: Step[] }): ParsedTurn {
  const turn = emptyTurn()
  for (const step of interaction.steps ?? []) {
    if (step.type === 'model_output') {
      const t = textOf(step)
      if (t) turn.text.push(t)
    }
    if (step.type !== 'function_call' || !step.id || !step.name) continue
    const args = step.arguments ?? {}
    if (typeof args.intent === 'string') turn.text.push(args.intent) // Gemini narrates every call through `intent`
    const safety = args.safety_decision as { decision?: string } | undefined
    if (safety?.decision === 'require_confirmation') turn.safety.push({ provider: 'google', callId: step.id, detail: safety })
    if (BUTTONS[step.name] && typeof args.x === 'number' && typeof args.y === 'number')
      turn.actions.push({ kind: 'click', callId: step.id, x: args.x, y: args.y, space: 'normalized1000', button: BUTTONS[step.name] })
    else if (step.name === 'take_screenshot') turn.actions.push({ kind: 'screenshot', callId: step.id })
    else turn.actions.push({ kind: 'other', callId: step.id, name: step.name, input: args })
  }
  return turn
}

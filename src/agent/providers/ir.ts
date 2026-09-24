export type IrAction =
  | { kind: 'click'; callId: string; x: number; y: number; space: 'pixels' | 'normalized1000'; button: 'left' | 'right' | 'middle' }
  | { kind: 'screenshot'; callId: string }
  | { kind: 'other'; callId: string; name: string; input: unknown }

export type SafetySignal = { provider: 'openai' | 'google'; callId: string; detail: unknown }
export type ParsedTurn = { actions: IrAction[]; refusal: boolean; text: string[]; safety: SafetySignal[] }

export const emptyTurn = (): ParsedTurn => ({ actions: [], refusal: false, text: [], safety: [] })

export type Space = 'pixels' | 'normalized1000'
export type IrPoint = { x: number; y: number }

/**
 * One provider-neutral action. Coordinates stay in the model's space (`space`) until the executor maps them through the
 * run's Frame. `keys` are the provider's own key names; `loop/keys.ts` turns them into Cua's.
 */
export type IrAction =
  | { kind: 'click'; callId: string; x: number; y: number; space: Space; button: 'left' | 'right' | 'middle'; count?: number; keys?: string[] }
  | { kind: 'move'; callId: string; x: number; y: number; space: Space }
  | { kind: 'drag'; callId: string; path: IrPoint[]; space: Space; keys?: string[] }
  | { kind: 'scroll'; callId: string; x: number; y: number; space: Space; dx: number; dy: number; keys?: string[] }
  | { kind: 'type'; callId: string; text: string }
  | { kind: 'keys'; callId: string; keys: string[] }
  | { kind: 'wait'; callId: string }
  | { kind: 'screenshot'; callId: string }
  /** A custom function tool (list_windows, open_app, …); `input` is null when the arguments were not valid JSON. */
  | { kind: 'tool'; callId: string; name: string; input: unknown }
  /** Anything the IR can't express. It is answered as unsupported, never guessed at. */
  | { kind: 'other'; callId: string; name: string; input: unknown }

export type SafetySignal = { provider: 'openai' | 'google'; callId: string; detail: unknown }
export type ParsedTurn = { actions: IrAction[]; refusal: boolean; text: string[]; safety: SafetySignal[] }

export const emptyTurn = (): ParsedTurn => ({ actions: [], refusal: false, text: [], safety: [] })

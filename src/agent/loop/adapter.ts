import type { Size } from '../frame/frame'
import type { ParsedTurn } from '../providers/ir'

export type Usage = { inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number }
export type Turn = ParsedTurn & { id: string; usage: Usage }

/** Exactly one result per call, in call order (spec §7 rule 4). A computer call's output is the latest screenshot. */
export type CallResult =
  /** `status` says whether the call's actions ran; `not-run` when an earlier failure in the turn halted it (spec §7). */
  | { callId: string; kind: 'computer'; acknowledged?: unknown[]; status?: 'ok' | 'failed' | 'not-run'; message?: string }
  | { callId: string; kind: 'function'; name: string; output: string }

/** A provider behind the IR. Tools and instructions are fixed when the adapter is made and never change during a run. */
export interface Adapter {
  readonly provider: 'openai' | 'anthropic' | 'google'
  readonly model: string
  readonly canvas: Size
  /** `image` is a base64 PNG exactly `canvas` in size. */
  start(input: { task: string; context: string; image?: string }, signal?: AbortSignal): Promise<Turn>
  /** `url` is the web page the target shows, when it is one (Gemini asks for it with every result). */
  next(input: { results: CallResult[]; image?: string; notes: string[]; url?: string }, signal?: AbortSignal): Promise<Turn>
  /** Cleans up provider-side state when the run ends (Gemini's stored interactions). */
  close?(): Promise<void>
}

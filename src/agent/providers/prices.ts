import type { Usage } from '../loop/adapter'

/** USD per million tokens, standard or paid tier. */
type Price = { input: number; cachedInput: number; cacheWrite: number; output: number }

const PRICES: Record<string, Price> = {
  'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  // Claude: cache reads are 0.1× input and 5-minute cache writes 1.25× (Anthropic pricing, spec appendix rates).
  'claude-opus-5-5': { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  'claude-sonnet-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-fable-5-1': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  // Gemini API pricing page, read 2026-09-24. 3.8 Flash doubles on 2027-01-01. Gemini has no cache-write charge.
  'gemini-3.8-flash': { input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, output: 3.75 },
  'gemini-3.5-flash': { input: 1.5, cachedInput: 0.15, cacheWrite: 1.5, output: 9 },
  // Claude Code driving over MCP: JevAuto calls no model, so its runs cost nothing here.
  'claude-code': { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
}

/** `input_tokens` includes the cached and cache-write tokens; each part has its own rate. Unknown models return undefined. */
export function costUsd(model: string, u: Usage): number | undefined {
  const p = PRICES[model]
  if (!p) return undefined
  const uncached = Math.max(0, u.inputTokens - u.cachedTokens - u.cacheWriteTokens)
  return (uncached * p.input + u.cachedTokens * p.cachedInput + u.cacheWriteTokens * p.cacheWrite + u.outputTokens * p.output) / 1e6
}

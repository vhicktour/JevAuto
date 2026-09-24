import type { Usage } from '../loop/adapter'

/** USD per million tokens, standard tier (OpenAI pricing page, read 2026-09-24). */
type Price = { input: number; cachedInput: number; cacheWrite: number; output: number }

const PRICES: Record<string, Price> = {
  'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
}

/** `input_tokens` includes the cached and cache-write tokens; each part has its own rate. Unknown models return undefined. */
export function costUsd(model: string, u: Usage): number | undefined {
  const p = PRICES[model]
  if (!p) return undefined
  const uncached = Math.max(0, u.inputTokens - u.cachedTokens - u.cacheWriteTokens)
  return (uncached * p.input + u.cachedTokens * p.cachedInput + u.cacheWriteTokens * p.cacheWrite + u.outputTokens * p.output) / 1e6
}

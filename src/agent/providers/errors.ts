export type Provider = 'openai' | 'anthropic' | 'google'

const NAMES: Record<Provider, { label: string; key: string; billing: string }> = {
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', billing: 'platform.openai.com → Settings → Billing' },
  anthropic: { label: 'Anthropic', key: 'ANTHROPIC_API_KEY', billing: 'console.anthropic.com → Billing' },
  google: { label: 'Google', key: 'GEMINI_API_KEY', billing: 'Google AI Studio → Billing' },
}

type Failure = { status?: number; code?: unknown; type?: unknown; name?: string; message?: string; error?: { code?: unknown; type?: unknown } }
const fields = (e: unknown): Failure => (e && typeof e === 'object' ? (e as Failure) : { message: String(e) })
const said = (f: Failure, word: string) => [f.code, f.type, f.error?.code, f.error?.type].some((v) => typeof v === 'string' && v.includes(word))

/** A 429 can mean "slow down" or "no money left"; only the second one is fixed by the user, not by waiting. */
const outOfCredit = (f: Failure) => f.status === 429 && (said(f, 'insufficient_quota') || said(f, 'credit_balance') || said(f, 'billing'))

/** One plain sentence about what went wrong with the model provider and what fixes it. */
export function explainError(provider: Provider, error: unknown): string {
  const p = NAMES[provider]
  const f = fields(error)
  if (outOfCredit(f)) return `Your ${p.label} account is out of credits. Add credits at ${p.billing}, then run the task again.`
  if (f.status === 429) return `${p.label}'s rate limit was reached. Try again in a minute.`
  if (f.status === 401) return `${p.label} rejected the API key. Check ${p.key} in .env.local.`
  if (f.status === 403) return `${p.label} refused this request (403). Check that ${p.key} is allowed to use this model.`
  if (f.status === 404) return `${p.label} doesn't offer this model to your key. Pick another model.`
  if (typeof f.status === 'number' && f.status >= 500) return `${p.label} had a server error. Try again.`
  if (f.name === 'APIConnectionError' || f.name === 'APIConnectionTimeoutError') return `JevAuto couldn't reach ${p.label}. Check the internet connection.`
  return f.message ?? 'Something went wrong.'
}

/** Worth asking again: rate limits, timeouts, conflicts, server errors and dropped connections. Never an empty balance. */
export function shouldRetry(error: unknown): boolean {
  const f = fields(error)
  if (outOfCredit(f)) return false
  if (f.name === 'APIConnectionError' || f.name === 'APIConnectionTimeoutError') return true
  return f.status === 408 || f.status === 409 || f.status === 429 || (typeof f.status === 'number' && f.status >= 500)
}

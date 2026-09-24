/** The models the task box offers, best first per provider (spec §7), and the key each one needs. */
export const MODELS = [
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', key: 'openai' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', key: 'google' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', key: 'anthropic' },
] as const

export type ModelId = (typeof MODELS)[number]['id']

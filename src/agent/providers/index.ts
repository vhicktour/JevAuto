import type { Adapter } from '../loop/adapter'
import type { AgentInit } from '../../shared/protocol'
import { geminiAdapter } from './google/adapter'
import { openAIAdapter } from './openai/adapter'

export type Keys = NonNullable<AgentInit['keys']>

/** The adapter for a model, by its family. Throws with a plain message when that provider's key is missing. */
export function adapterFor(model: string, instructions: string, keys: Keys): Adapter {
  if (model.startsWith('gpt-')) {
    if (!keys.openai) throw new Error('No OpenAI key: add OPENAI_API_KEY to .env.local, then restart JevAuto.')
    return openAIAdapter(model, instructions, keys.openai)
  }
  if (model.startsWith('gemini-')) {
    if (!keys.google) throw new Error('No Gemini key: add GEMINI_API_KEY to .env.local, then restart JevAuto.')
    return geminiAdapter(model, instructions, keys.google)
  }
  throw new Error(`JevAuto has no adapter for ${model} yet.`)
}
